// 5-minute decision loop. Called by Vercel Cron per vercel.json.
//
// For now: READ from mockStatus (same contract the client uses) → DECIDE
// via the pure engine → LOG the outcome in the in-memory action store.
// Once integrations land: READ from Enphase + Tesla + Rivian adapters,
// then ACT by POSTing to Tesla Fleet's reserve endpoint.
//
// Hysteresis guard: min_action_interval_sec throttles reserve writes.

import {
  appendAction,
  getConfig,
  secondsSinceLastAction,
  writeSnapshot,
} from "@/lib/db";
import { decide } from "@/lib/decide";
import { decideEvCharge } from "@/lib/decideEvCharge";
import { mockForecast, mockStatus } from "@/lib/mock";
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

  const status = mockStatus();
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
    // TODO: call Tesla Fleet reserve write here once integration lands.
    await appendAction({
      type: "reserve",
      title: `Set reserve to ${decision.target_reserve_pct}%`,
      reason: decision.reasoning.slice(-2).join(" "),
      ok: true,
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
    // TODO: call Rivian charge-start here once integration lands.
    const rate = evDecision.desired_rate_kw
      ? ` at ${evDecision.desired_rate_kw} kW`
      : "";
    await appendAction({
      type: "charge",
      title: `Start EV charge${rate}`,
      reason: evDecision.reason,
      ok: true,
    });
    evActed = true;
  } else if (evDecision.action === "stop" && isCharging) {
    // TODO: call Rivian charge-stop here once integration lands.
    await appendAction({
      type: "charge",
      title: "Stop EV charge",
      reason: evDecision.reason,
      ok: true,
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
