import { listActions, stripSignatureMarker } from "@/lib/db";
import { mockActions } from "@/lib/mock";

// Merges the in-memory action log (new cron runs, reserve POSTs) with the
// seeded mock entries so the Activity screen shows real activity first.
//
// EV recommendations carry a trailing [helios-sig:…] marker in their
// reason field for cron-side dedup; strip it here so the UI sees clean
// copy.
export async function GET() {
  const live = await listActions();
  const mock = mockActions().actions;
  const cleaned = live.map((a) => ({
    ...a,
    reason: stripSignatureMarker(a.reason),
  }));
  return Response.json({ actions: [...cleaned, ...mock] });
}
