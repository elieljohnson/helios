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
  appendRecommendation,
  captureForecastSnapshot,
  detectEvSession,
  getConfig,
  getMostRecentSnapshot,
  getToken,
  lastPushTimestamp,
  lastRecommendationSignature,
  rollupYesterday,
  secondsSinceLastAction,
  writeSnapshot,
} from "@/lib/db";
import { decide } from "@/lib/decide";
import { decideEvCharge } from "@/lib/decideEvCharge";
import { mockForecast } from "@/lib/mock";
import { sendPushToAll } from "@/lib/push";
import { recommendEvAction } from "@/lib/recommendEvAction";
import { assembleStatus } from "@/lib/status";
import {
  isConfigured as teslaConfigured,
  setBackupReserve,
} from "@/lib/tesla";
import { fetchForecast } from "@/lib/weather";

/** Minimum seconds between high-priority pushes. Independent of the
 *  recommendation-log dedup (which fires on signature change every
 *  ~30 min during charging as SoC ticks up). The push throttle
 *  protects the user's lock screen from a buzz every 5–30 min — high-
 *  priority changes are still surfaced via the dashboard banner and
 *  activity feed in the meantime.
 *
 *  15 min default lines up with the "user notices and walks to the
 *  car" rhythm — fast enough that an over-target stop is actionable,
 *  slow enough that we never spam. */
const MIN_PUSH_INTERVAL_SEC = 15 * 60;

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

  // Forecast snapshot capture. Stores the forecast for the day on the
  // first tick AND on revisions ≥ 5 kWh from the last capture. Most
  // days produce 1–3 rows. Used by trend screens for actual-vs-forecast
  // analysis. Best-effort — if it throws, we don't block the cron.
  try {
    await captureForecastSnapshot({ forecast, now: new Date() });
  } catch (err) {
    console.error("[cron/decide] captureForecastSnapshot failed:", err);
  }

  // Yesterday's rollup. Idempotent — only inserts if no row exists for
  // yesterday's PT date yet. Cheapest at the first tick after PT
  // midnight; later ticks are one-row reads.
  try {
    await rollupYesterday({ now: new Date() });
  } catch (err) {
    console.error("[cron/decide] rollupYesterday failed:", err);
  }

  // Capture the previous snapshot before writing the new one. We need
  // the prev → current ev_charging transition for session detection.
  const prevSnapshot = await getMostRecentSnapshot();

  // Every tick: record the snapshot for history + self-sufficiency rollups.
  // We do this BEFORE the automation_enabled gate so paused mode still
  // produces an unbroken time series — critical for the learned home
  // curve and self-sufficiency rollups that integrate over days/weeks.
  const captured_at = await writeSnapshot(status.snapshot);

  // EV charge session detection. Compares prev vs current ev_charging
  // to open / accumulate / close session rows. Best-effort — failures
  // here don't break the cron, but the session row may be missing
  // for this tick.
  try {
    await detectEvSession({
      prevSnapshot,
      snapshot: status.snapshot,
      capturedAt: new Date(captured_at),
      touRate: status.snapshot.tou_rate,
    });
  } catch (err) {
    console.error("[cron/decide] detectEvSession failed:", err);
  }

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
  // (Rivian app → Charging → set charge limit, or unplug). The
  // recommendation is logged to the activity feed only when its
  // signature changes, so the feed reflects state transitions rather
  // than every 5-min tick. B4 will wire Web Push on high-priority
  // changes off the same signature gate.
  const evDecision = decideEvCharge({
    snapshot: status.snapshot,
    system: status.system,
    config,
    forecast,
    home_curve: status.home_curve,
  });

  const recommendation = recommendEvAction({
    decision: evDecision,
    snapshot: status.snapshot,
  });

  let recommendationLogged = false;
  let pushFired = false;
  let pushNote: string | null = null;
  const lastSig = await lastRecommendationSignature();
  if (recommendation.signature !== lastSig) {
    // Push gate: high-priority recommendations fire a push, throttled
    // to MIN_PUSH_INTERVAL_SEC since the last push to avoid lock-
    // screen spam. Banner + activity feed always surface; the throttle
    // only suppresses the buzz.
    let pushedAt: Date | null = null;
    if (recommendation.priority === "high") {
      const lastPush = await lastPushTimestamp();
      const sinceLastPush = lastPush
        ? (Date.now() - lastPush.getTime()) / 1000
        : Infinity;
      if (sinceLastPush >= MIN_PUSH_INTERVAL_SEC) {
        try {
          const r = await sendPushToAll({
            title: recommendation.title,
            body: recommendation.body,
            url: recommendation.rivianAppUrl,
            tag: `helios-${recommendation.kind}`,
          });
          pushFired = r.delivered > 0;
          pushedAt = pushFired ? new Date() : null;
          pushNote = `delivered ${r.delivered}/${r.attempted}` +
            (r.removedStale ? `, purged ${r.removedStale} stale` : "");
        } catch (err) {
          console.error("[cron/decide] push send threw:", err);
          pushNote = "push send threw — see logs";
        }
      } else {
        pushNote = `throttled (${Math.round(sinceLastPush)}s < ${MIN_PUSH_INTERVAL_SEC}s)`;
      }
    }

    await appendRecommendation({
      title: recommendation.title,
      body: recommendation.body,
      signature: recommendation.signature,
      pushedAt,
      // ok=true: this is a recommendation, not a failed write. The
      // activity feed reads ok as "did the engine succeed at what it
      // tried to do" — under Option B, "what it tried to do" is
      // surface a recommendation, which always succeeds.
      ok: true,
      targetValue: evDecision.desired_rate_kw ?? null,
      prevValue: status.snapshot.ev_w / 1000,
      // Structured projection metadata (migration 0014). Persisted
      // alongside the recommendation so future trend screens can
      // query "how often did defend zone refuse?" or "what was the
      // median projected_end_pw_pct?" without parsing reason text.
      // Mode/zone come from the projection result; nullable on
      // legacy code paths and on stop/hold decisions that bypass
      // the projection (gate-3 stops, past-cutoff backstop, etc.).
      mode: evDecision.mode ?? null,
      zone: evDecision.zone ?? null,
      evChargeLimitPct: evDecision.ev_charge_limit_pct ?? null,
      projectedEndPwPct: evDecision.projected_end_pw_pct ?? null,
      projectedDeparturePwPct: evDecision.projected_departure_pw_pct ?? null,
    });
    recommendationLogged = true;
  }

  return Response.json({
    ran_at: new Date().toISOString(),
    captured_at,
    decision,
    acted: reserveActed,
    ev_decision: evDecision,
    ev_recommendation: {
      kind: recommendation.kind,
      priority: recommendation.priority,
      signature: recommendation.signature,
      logged: recommendationLogged,
      pushed: pushFired,
      push_note: pushNote,
    },
  });
}
