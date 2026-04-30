// Live "what would the engines do right now?" endpoint. Runs decide()
// + decideEvCharge() against the current snapshot + forecast + config
// without writing anything. Drives the Settings page's preview card so
// users can tweak policy and see the rule output immediately, before
// the next 5-min cron tick.

import { getConfig } from "@/lib/db";
import { decide } from "@/lib/decide";
import { decideEvCharge } from "@/lib/decideEvCharge";
import { mockForecast } from "@/lib/mock";
import { assembleStatus } from "@/lib/status";
import { fetchForecast } from "@/lib/weather";

export async function GET() {
  // forEngine: true matches the cron path — the preview shows what the
  // engine WOULD do, so it should consume the same data sources cron
  // does (Tesla solar instead of Enphase). Skipping Enphase here also
  // means Settings-page hits don't burn the Watt-plan API budget.
  const status = await assembleStatus({ forEngine: true });
  let forecast;
  try {
    forecast = await fetchForecast();
  } catch (err) {
    console.error("[preview-decision] forecast fallback to mock:", err);
    forecast = mockForecast();
  }

  const config = await getConfig();

  const reserve_decision = decide({
    snapshot: status.snapshot,
    config,
    forecast,
  });
  const ev_decision = decideEvCharge({
    snapshot: status.snapshot,
    system: status.system,
    config,
    forecast,
    home_curve: status.home_curve,
  });

  // Surface non-live sources to the Settings preview so the user can
  // tell apart "this is what the engine would do RIGHT NOW with live
  // data" from "this preview is running on stale mock seeds because
  // a provider is down." The cron loop refuses to actuate in the latter
  // case (see app/api/cron/decide/route.ts); the preview form should
  // visibly degrade rather than confidently render phantom output.
  const stale: string[] = [];
  if (status.sources.solar.status !== "live") stale.push("solar");
  if (status.sources.home.status !== "live") stale.push("home");
  if (status.sources.powerwall.status !== "live") stale.push("powerwall");

  return Response.json({
    timestamp: new Date().toISOString(),
    snapshot: status.snapshot,
    system: status.system,
    sunrise: forecast.daily[0]?.sunrise,
    sunset: forecast.daily[0]?.sunset,
    tomorrow_kwh: forecast.daily[1]?.kwh,
    config,
    reserve_decision,
    ev_decision,
    sources: status.sources,
    stale_domains: stale,
  });
}
