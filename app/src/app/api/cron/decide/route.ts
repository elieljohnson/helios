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

  const status = await assembleStatus();
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
  const captured_at = await writeSnapshot(status.snapshot);

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
  if (evDecision.action === "start" && !isCharging) {
    const rate = evDecision.desired_rate_kw
      ? ` at ${evDecision.desired_rate_kw} kW`
      : "";
    let writeOk = true;
    let writeNote = "";
    if (await smartcarConfigured()) {
      try {
        await startCharging();
      } catch (err) {
        writeOk = false;
        writeNote = err instanceof Error ? err.message : "Smartcar call failed";
        console.error("[cron/decide] charge-start failed:", err);
      }
    } else {
      writeNote = "Smartcar not connected — logged only";
    }
    await appendAction({
      type: "charge",
      title: `Start EV charge${rate}${writeOk ? "" : " (write failed)"}`,
      reason: writeNote
        ? `${evDecision.reason} — ${writeNote}.`
        : evDecision.reason,
      ok: writeOk,
    });
    evActed = true;
  } else if (evDecision.action === "stop" && isCharging) {
    let writeOk = true;
    let writeNote = "";
    if (await smartcarConfigured()) {
      try {
        await stopCharging();
      } catch (err) {
        writeOk = false;
        writeNote = err instanceof Error ? err.message : "Smartcar call failed";
        console.error("[cron/decide] charge-stop failed:", err);
      }
    } else {
      writeNote = "Smartcar not connected — logged only";
    }
    await appendAction({
      type: "charge",
      title: `Stop EV charge${writeOk ? "" : " (write failed)"}`,
      reason: writeNote
        ? `${evDecision.reason} — ${writeNote}.`
        : evDecision.reason,
      ok: writeOk,
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
