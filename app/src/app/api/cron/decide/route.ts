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

  // CRITICAL: never compute decisions or actuate from non-live data.
  //
  // assembleStatus seeds from mockStatus() and overlays each provider's
  // real values. Each domain's source carries a ProviderStatus tag:
  //   - "live"        — provider succeeded this tick.
  //   - "unavailable" — provider was attempted and threw (rate limit,
  //                     OAuth lapse, transient timeout). Snapshot value
  //                     for this domain is the prior mock seed.
  //   - "mock"        — provider not configured. Snapshot value is the
  //                     mock seed too.
  //
  // The mock seed is calibrated to a sunny noon snapshot (solar_w 7700,
  // pw_soc 78, etc.) which means at 2 AM with Tesla failing, the
  // engine would see "PW above floor + 7.7 kW solar surplus" and fire
  // pre-departure mode at full rate. Real-world incident on 2026-04-29
  // cost ~$6.73 in unintended grid imports overnight.
  //
  // Defensive gate: if any of the three power-flow sources (solar,
  // home, powerwall) is anything other than "live" after assembleStatus,
  // refuse to write a snapshot or fire any actuator. Log an info-level
  // skip and bail. Next tick re-runs assembleStatus from scratch and
  // recovers naturally when the upstream provider is back.
  //
  // We don't write the snapshot in this branch because non-live values
  // would poison the rollup queries (cost integration, self-sufficiency,
  // learned home curve). Better to have a missing 5-min bucket than a
  // contaminated one.
  const stale: string[] = [];
  if (status.sources.solar.status !== "live") stale.push(`solar(${status.sources.solar.status})`);
  if (status.sources.home.status !== "live") stale.push(`home(${status.sources.home.status})`);
  if (status.sources.powerwall.status !== "live") stale.push(`powerwall(${status.sources.powerwall.status})`);
  if (stale.length > 0) {
    await appendAction({
      type: "info",
      title: `Cron skipped — ${stale.join(", ")} not live`,
      reason: `assembleStatus returned non-live data for ${stale.join(", ")}. ` +
        `Engine paused actuation to avoid acting on phantom values. ` +
        `Next tick retries.`,
      ok: true,
      targetValue: null,
      prevValue: null,
    });
    return Response.json({
      ran_at: new Date().toISOString(),
      paused: true,
      reason: `non-live data for ${stale.join(", ")} — engine refusing to act`,
      sources: status.sources,
    });
  }

  // Policy comes from Postgres user_config (or memory fallback). The
  // Settings UI mutates this row, so changes take effect on this very
  // next tick after save.
  //
  // On a DB hiccup (Neon cold-start timeout, transient network blip)
  // the unwrapped query would throw and the route would 500 — Vercel
  // logs the stack but the cron tick is silently lost. Wrap so the
  // failure is visible (paused JSON response, distinct reason code)
  // and the next tick retries naturally. We do NOT fall back to
  // DEFAULT_CONFIG on failure: the user may have tuned policy that
  // we'd quietly ignore for one tick, which is exactly the same
  // "act on plausible-looking-but-wrong values" anti-pattern the
  // 2026-04-29 postmortem called out.
  let config: Awaited<ReturnType<typeof getConfig>>;
  try {
    config = await getConfig();
  } catch (err) {
    console.error("[cron/decide] getConfig failed:", err);
    return Response.json({
      ran_at: new Date().toISOString(),
      paused: true,
      reason: "getConfig() failed — DB unavailable; engine refusing to act on default policy",
    });
  }

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
