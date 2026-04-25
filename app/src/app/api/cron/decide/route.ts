// 5-minute decision loop. Called by Vercel Cron per vercel.json.
//
// For now: READ from mockStatus (same contract the client uses) → DECIDE
// via the pure engine → LOG the outcome in the in-memory action store.
// Once integrations land: READ from Enphase + Tesla + Rivian adapters,
// then ACT by POSTing to Tesla Fleet's reserve endpoint.
//
// Hysteresis guard: min_action_interval_sec throttles reserve writes.

import { DEFAULT_CONFIG } from "@/lib/config";
import { appendAction, secondsSinceLastAction, writeSnapshot } from "@/lib/db";
import { decide } from "@/lib/decide";
import { mockForecast, mockStatus } from "@/lib/mock";

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
  const forecast = mockForecast();

  // Every tick: record the snapshot for history + self-sufficiency rollups.
  const captured_at = await writeSnapshot(status.snapshot);

  const decision = decide({
    snapshot: status.snapshot,
    config: DEFAULT_CONFIG,
    forecast,
  });

  const cooldown = await secondsSinceLastAction();
  if (decision.should_act && cooldown < DEFAULT_CONFIG.min_action_interval_sec) {
    const entry = await appendAction({
      type: "info",
      title: `Decision throttled (cooldown ${Math.round(cooldown)}s)`,
      reason: `Target ${decision.target_reserve_pct}% held back by ${DEFAULT_CONFIG.min_action_interval_sec}s interval guard.`,
      ok: true,
    });
    return Response.json({ ran_at: entry.timestamp, captured_at, decision, acted: false, reason: "cooldown" });
  }

  if (decision.should_act) {
    // TODO: call Tesla Fleet reserve write here once integration lands.
    const entry = await appendAction({
      type: "reserve",
      title: `Set reserve to ${decision.target_reserve_pct}%`,
      reason: decision.reasoning.slice(-2).join(" "),
      ok: true,
    });
    return Response.json({ ran_at: entry.timestamp, captured_at, decision, acted: true });
  }

  return Response.json({ ran_at: new Date().toISOString(), captured_at, decision, acted: false });
}
