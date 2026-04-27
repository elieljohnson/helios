// 5-minute decision loop. Called by GitHub Actions cron.
//
// READ → assembleStatus() composes the snapshot from connected providers
//        (Enphase for solar, Tesla for Powerwall + load, Smartcar for EV).
// DECIDE → decide() (PW reserve target) + decideEvCharge() (EV start/stop).
// ACT   → if Tesla is connected, POST backup_reserve_percent to Fleet API.
//         If Smartcar is connected, POST start/stop to the Rivian charger.
// LOG   → control_actions row for every state change.
//
// Hysteresis guard: min_action_interval_sec throttles reserve writes.

import {
  appendAction,
  getConfig,
  getToken,
  secondsSinceLastAction,
  writeSnapshot,
} from "@/lib/db";
import { decide } from "@/lib/decide";
import { decideEvCharge } from "@/lib/decideEvCharge";
import { mockForecast } from "@/lib/mock";
import {
  isConfigured as rivianConfigured,
  startCharging as rivianStartCharging,
  stopCharging as rivianStopCharging,
} from "@/lib/rivian";
import {
  isConfigured as smartcarConfigured,
  startCharging,
  stopCharging,
} from "@/lib/smartcar";
import { assembleStatus } from "@/lib/status";
import {
  isConfigured as teslaConfigured,
  setBackupReserve,
} from "@/lib/tesla";
import { fetchForecast } from "@/lib/weather";

export async function GET(request: Request) {
  // Vercel cron requests include a bearer token matching CRON_SECRET when
  // the env var is set. In dev it's unset — skip the check then.
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${expected}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  // forEngine: true skips Enphase to keep cron off the Watt-plan API
  // budget. Tesla's live_status.solar_power is the fallback (~5% off
  // Enphase's IQ8X-direct reading; immaterial at the engine's kWh-
  // budget granularity). Dashboard /api/status keeps Enphase as
  // primary for accurate human-facing display.
  const status = await assembleStatus({ forEngine: true });
  // Policy comes from Postgres user_config (or memory fallback). The
  // Settings UI mutates this row, so changes take effect on this very
  // next tick after save.
  const config = await getConfig();

  // Real weather from Open-Meteo. If it fails, fall back to mock so the
  // tick still records a snapshot — the storm guard simply won't fire.
  let forecast;
  try {
    forecast = await fetchForecast();
  } catch (err) {
    console.error("[cron/decide] forecast fallback to mock:", err);
    forecast = mockForecast();
  }

  // Every tick: record the snapshot for history + self-sufficiency rollups.
  // We do this BEFORE the automation_enabled gate so paused mode still
  // produces an unbroken time series — critical for the learned home
  // curve and self-sufficiency rollups that integrate over days/weeks.
  const captured_at = await writeSnapshot(status.snapshot);

  // Master pause switch. When false, the engine still observes (snapshot
  // is written above, decisions could still be computed) but no
  // actuator calls fire — Powerwall reserve isn't written, Rivian
  // schedules aren't pushed. Use case: pre-trip, manual control of
  // PW + EV without disconnecting integrations or fighting the cron.
  if (!config.automation_enabled) {
    return Response.json({
      ran_at: new Date().toISOString(),
      captured_at,
      paused: true,
      reason: "automation_enabled=false — engine paused by user, no actions fired",
    });
  }

  const decision = decide({
    snapshot: status.snapshot,
    config,
    forecast,
  });

  const cooldown = await secondsSinceLastAction();
  if (decision.should_act && cooldown < config.min_action_interval_sec) {
    const entry = await appendAction({
      type: "info",
      title: `Decision throttled (cooldown ${Math.round(cooldown)}s)`,
      reason: `Target ${decision.target_reserve_pct}% held back by ${config.min_action_interval_sec}s interval guard.`,
      ok: true,
      targetValue: decision.target_reserve_pct,
      prevValue: status.snapshot.pw_reserve,
    });
    return Response.json({ ran_at: entry.timestamp, captured_at, decision, acted: false, reason: "cooldown" });
  }

  let reserveActed = false;
  if (decision.should_act) {
    // If Tesla is connected, actually write the reserve. Otherwise log
    // the intent so the activity log still tells the same story.
    let writeOk = true;
    let writeNote = "";
    if (await teslaConfigured()) {
      try {
        const tok = await getToken("tesla");
        if (tok?.system_id) {
          const ack = await setBackupReserve(tok.system_id, decision.target_reserve_pct);
          writeOk = ack.ok;
          writeNote = writeOk ? "" : "Tesla returned non-success";
        } else {
          writeOk = false;
          writeNote = "no energy_site_id pinned";
        }
      } catch (err) {
        writeOk = false;
        writeNote = err instanceof Error ? err.message : "Tesla call failed";
        console.error("[cron/decide] reserve write failed:", err);
      }
    } else {
      writeNote = "Tesla not connected — logged only";
    }

    await appendAction({
      type: "reserve",
      title: `Set reserve to ${decision.target_reserve_pct}%${writeOk ? "" : " (write failed)"}`,
      reason: writeNote
        ? `${decision.reasoning.slice(-1)[0]} — ${writeNote}.`
        : decision.reasoning.slice(-2).join(" "),
      ok: writeOk,
      targetValue: decision.target_reserve_pct,
      prevValue: status.snapshot.pw_reserve,
    });
    reserveActed = true;
  }

  // EV charging decision. Only logs an action when the desired charge state
  // changes (start while stopped or stop while charging) — avoids spamming
  // the activity log on every 5-min tick.
  const evDecision = decideEvCharge({
    snapshot: status.snapshot,
    system: status.system,
    config,
    forecast,
    home_curve: status.home_curve,
  });

  let evActed = false;
  const isCharging = status.snapshot.ev_charging;
  const currentRateKw = status.snapshot.ev_w / 1000;
  const desiredRateKw = evDecision.desired_rate_kw ?? 0;
  // Re-fire the schedule when the rate has meaningfully drifted from
  // what the car is actually drawing. Without this, we'd push one
  // schedule on the initial start and then never update — the rate
  // would stay frozen at the original budget calc even as conditions
  // change (PW finishes filling, solar peaks/dips, EV approaches
  // limit). 1.0 kW threshold is wide enough to ignore noise/jitter,
  // narrow enough that the user sees the rate ramp up as PW hits
  // target and surplus shifts to the car.
  const RATE_UPDATE_THRESHOLD_KW = 1.0;
  const rateDrifted =
    isCharging &&
    desiredRateKw > 0 &&
    Math.abs(desiredRateKw - currentRateKw) >= RATE_UPDATE_THRESHOLD_KW;

  if (evDecision.action === "start" && (!isCharging || rateDrifted)) {
    const rate = evDecision.desired_rate_kw
      ? ` at ${evDecision.desired_rate_kw} kW`
      : "";
    const verb = isCharging ? "Update" : "Start";
    const { writeOk, writeNote } = await fireEvAction({
      action: "start",
      rateKw: evDecision.desired_rate_kw,
      hoursToCutoff: hoursToSunset(forecast),
      coords: status.system.coords,
    });
    await appendAction({
      type: "charge",
      title: `${verb} EV charge${rate}${writeOk ? "" : " (write failed)"}`,
      reason: writeNote
        ? `${evDecision.reason} — ${writeNote}.`
        : evDecision.reason,
      ok: writeOk,
      targetValue: evDecision.desired_rate_kw ?? null,
      prevValue: currentRateKw,
    });
    evActed = true;
  } else if (evDecision.action === "stop" && isCharging) {
    const { writeOk, writeNote } = await fireEvAction({
      action: "stop",
      coords: status.system.coords,
    });
    await appendAction({
      type: "charge",
      title: `Stop EV charge${writeOk ? "" : " (write failed)"}`,
      reason: writeNote
        ? `${evDecision.reason} — ${writeNote}.`
        : evDecision.reason,
      ok: writeOk,
      targetValue: 0,
      prevValue: status.snapshot.ev_w / 1000,
    });
    evActed = true;
  }

  return Response.json({
    ran_at: new Date().toISOString(),
    captured_at,
    decision,
    acted: reserveActed,
    ev_decision: evDecision,
    ev_acted: evActed,
  });
}

/** Fire a start/stop charge action, preferring Rivian (working,
 *  authoritative) over Smartcar (broken pending V3 OAuth resolution).
 *  On failure: log + continue, per the Phase 2 default. The next 5-min
 *  cron tick re-evaluates and retries naturally. */
async function fireEvAction(opts: {
  action: "start" | "stop";
  rateKw?: number;
  hoursToCutoff?: number;
  coords?: { lat: number; lng: number };
}): Promise<{ writeOk: boolean; writeNote: string }> {
  if (await rivianConfigured()) {
    if (opts.action === "start") {
      if (!opts.coords) {
        return { writeOk: false, writeNote: "no home coords in system config" };
      }
      if (!opts.rateKw || opts.rateKw <= 0) {
        return {
          writeOk: false,
          writeNote: `invalid rate ${opts.rateKw ?? "(unset)"} kW`,
        };
      }
      try {
        const r = await rivianStartCharging({
          rateKw: opts.rateKw,
          durationHours: Math.max(opts.hoursToCutoff ?? 1, 0.25),
          coords: opts.coords,
        });
        return r.success
          ? {
              writeOk: true,
              writeNote: `Rivian schedule: ${r.amperage}A × ${r.durationMinutes}min`,
            }
          : { writeOk: false, writeNote: "Rivian returned success: false" };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Rivian call failed";
        console.error("[cron/decide] Rivian start failed:", err);
        return { writeOk: false, writeNote: `Rivian: ${msg}` };
      }
    }
    // stop
    if (!opts.coords) {
      return { writeOk: false, writeNote: "no home coords in system config" };
    }
    try {
      const r = await rivianStopCharging({ coords: opts.coords });
      return r.success
        ? { writeOk: true, writeNote: "Rivian: amp=0 schedule for today" }
        : { writeOk: false, writeNote: "Rivian returned success: false" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Rivian call failed";
      console.error("[cron/decide] Rivian stop failed:", err);
      return { writeOk: false, writeNote: `Rivian: ${msg}` };
    }
  }

  // Fallback: Smartcar (currently broken behind V3 OAuth gap; kept as
  // a configured-but-erroring path so re-enable is one ticket reply away).
  if (await smartcarConfigured()) {
    try {
      if (opts.action === "start") await startCharging();
      else await stopCharging();
      return { writeOk: true, writeNote: "" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Smartcar call failed";
      console.error(`[cron/decide] Smartcar ${opts.action} failed:`, err);
      return { writeOk: false, writeNote: `Smartcar: ${msg}` };
    }
  }

  return { writeOk: false, writeNote: "no EV actuator connected — logged only" };
}

/** Hours from now until sunset−buffer, used as the schedule duration
 *  for "start charging" calls. Caps at 0.25h floor so we never send a
 *  zero-duration window the car would silently ignore. */
function hoursToSunset(forecast: { daily: Array<{ sunset?: string }> }): number {
  const sunsetIso = forecast.daily[0]?.sunset;
  if (!sunsetIso) return 1;
  const sunsetMs = new Date(sunsetIso).getTime();
  const hours = (sunsetMs - Date.now()) / 3_600_000;
  return Math.max(0.25, +hours.toFixed(2));
}
