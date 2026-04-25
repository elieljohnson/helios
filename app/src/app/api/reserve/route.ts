import { appendAction } from "@/lib/db";
import { reserveRequestSchema } from "@/lib/schemas";
import type { ReserveResponse } from "@/lib/types";

// POST /api/reserve — the one action the PRD lets Helios actually take:
// manipulate Powerwall backup reserve %. The real implementation will call
// Tesla Fleet API's `off_grid_vehicle_charging_reserve` endpoint. For now,
// we validate the input, log it to the action store, and return ok.
export async function POST(request: Request) {
  const raw = await request.json().catch(() => null);
  const parsed = reserveRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const applied_pct = Math.round(parsed.data.reserve_pct);
  const action = await appendAction({
    type: "reserve",
    title: `Set Powerwall reserve to ${applied_pct}%`,
    reason: parsed.data.reason ?? "Manual override from /api/reserve.",
    ok: true,
  });

  const response: ReserveResponse = {
    ok: true,
    applied_pct,
    applied_at: action.timestamp,
  };
  return Response.json(response);
}
