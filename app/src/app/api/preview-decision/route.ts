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
  const status = await assembleStatus();
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
  });
}
