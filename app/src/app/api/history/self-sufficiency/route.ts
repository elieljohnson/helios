// Self-sufficiency time-series for the activity page chart. Backs a
// Day / Week / Month / Year tab selector — backend computes the
// integral over the requested window and bucket granularity.
//
//   GET /api/history/self-sufficiency?period=day|week|month|year
//
// Returns:
//   {
//     period: "day",
//     headline_pct: 98,                    // weighted across whole window
//     points: [
//       { label: "08", value: 100, home_kwh: 0.42 },
//       { label: "09", value: 99,  home_kwh: 0.51 },
//       ...
//     ]
//   }

import { getSelfSufficiencyHistory, type SelfSufficiencyPeriod } from "@/lib/db";

const VALID: SelfSufficiencyPeriod[] = ["day", "week", "month", "year"];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("period") ?? "day";
  const period = VALID.includes(raw as SelfSufficiencyPeriod)
    ? (raw as SelfSufficiencyPeriod)
    : ("day" as SelfSufficiencyPeriod);
  const data = await getSelfSufficiencyHistory(period);
  return Response.json(data);
}
