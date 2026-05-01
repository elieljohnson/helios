// GET /api/recommendation
//
// Live "what should the user do right now?" endpoint. Re-runs
// assembleStatus + decideEvCharge + recommendEvAction against current
// state. Powers the dashboard's RecommendationBanner.
//
// Design choice: this is a separate read endpoint rather than slipping
// the recommendation into /api/status, because (a) the banner has a
// different polling cadence (30s vs 5m) and (b) the recommendation
// pipeline depends on the forecast, which /api/status doesn't already
// fetch. Keeping it isolated also means the banner's load doesn't
// block the dashboard's first paint.

import { getConfig } from "@/lib/db";
import { decideEvCharge } from "@/lib/decideEvCharge";
import { mockForecast } from "@/lib/mock";
import { recommendEvAction } from "@/lib/recommendEvAction";
import { assembleStatus } from "@/lib/status";
import { fetchForecast } from "@/lib/weather";

export type RecommendationResponse = {
  kind: "stop" | "start" | "noop";
  priority: "high" | "info";
  title: string;
  body: string;
  rivianAppUrl: string;
  signature: string;
  /** True if any of solar/home/powerwall is non-live. The banner
   *  honors this — better to suppress a recommendation than render
   *  one based on stale data. */
  stale: boolean;
};

export async function GET() {
  // forEngine: true matches the cron path — same data sources, same
  // staleness gate, same answer the cron would land on this tick.
  const status = await assembleStatus({ forEngine: true });

  const isStale =
    status.sources.solar.status !== "live" ||
    status.sources.home.status !== "live" ||
    status.sources.powerwall.status !== "live";

  let forecast;
  try {
    forecast = await fetchForecast();
  } catch (err) {
    console.error("[recommendation] forecast fallback to mock:", err);
    forecast = mockForecast();
  }

  const config = await getConfig();

  const evDecision = decideEvCharge({
    snapshot: status.snapshot,
    system: status.system,
    config,
    forecast,
    home_curve: status.home_curve,
  });

  const rec = recommendEvAction({
    decision: evDecision,
    snapshot: status.snapshot,
  });

  const response: RecommendationResponse = {
    kind: rec.kind,
    priority: rec.priority,
    title: rec.title,
    body: rec.body,
    rivianAppUrl: rec.rivianAppUrl,
    signature: rec.signature,
    stale: isStale,
  };
  return Response.json(response);
}
