// One-shot endpoint: for each of the past N PT days, return the
// lowest pw_soc observed between PT 00:00 and PT 08:00. Used to
// inform pw_sunset_target_pct tuning — if overnight lows are
// comfortably above the target, the target is conservative.
//
//   GET /api/history/morning-pw-lows?days=7
//
// Returns: { days, lows: [ { date, min_pw_soc, min_at_hour_pt, sample_count } ] }

import { getMorningPwLows } from "@/lib/db";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("days") ?? "7";
  const parsed = parseInt(raw, 10);
  const days = Number.isFinite(parsed) && parsed >= 1 && parsed <= 60 ? parsed : 7;
  const lows = await getMorningPwLows(days);
  return Response.json({ days, lows });
}
