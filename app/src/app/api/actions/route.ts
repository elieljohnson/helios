import { listActions } from "@/lib/db";
import { mockActions } from "@/lib/mock";

// Merges the in-memory action log (new cron runs, reserve POSTs) with the
// seeded mock entries so the Activity screen shows real activity first.
export async function GET() {
  const live = await listActions();
  const mock = mockActions().actions;
  return Response.json({ actions: [...live, ...mock] });
}
