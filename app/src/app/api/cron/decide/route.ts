// 5-minute decision loop. Called by GitHub Actions cron.
//
// READ → assembleStatus() composes the snapshot from connected providers
//        (Enphase for solar, Tesla for Powerwall + load, Rivian/Smartcar
//        for EV reads).
// DECIDE → decide() (PW reserve target) + decideEvCharge() (EV recommendation).
// ACT   → if Tesla is connected, POST backup_reserve_percent to Fleet API.
//         EV side is recommendation-only under Option B (locked 2026-05-01) —
//         no actuator is called. B2 wires recommendation logging into the
//         activity feed.
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

  // EV charging decision. Under Option B, Helios computes the
  // recommendation but does NOT actuate — the user is the actuator
  // (Rivian app → Charging → set charge limit, or unplug). B1 wires
  // a pure recommendEvAction function; B2 logs recommendations to
  // the activity feed and sends Web Push for high-priority changes.
  // For now: compute the decision and surface it in the response
  // JSON for diagnostic visibility, no side effects.
  const evDecision = decideEvCharge({
    snapshot: status.snapshot,
    system: status.system,
    config,
    forecast,
    home_curve: status.home_curve,
  });

  return Response.json({
    ran_at: new Date().toISOString(),
    captured_at,
    decision,
    acted: reserveActed,
    ev_decision: evDecision,
    ev_acted: false,
  });
}
