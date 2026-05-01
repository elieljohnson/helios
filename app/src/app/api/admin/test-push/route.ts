// POST /api/admin/test-push
//
// Admin-gated: fires a hardcoded test payload via sendPushToAll. Used
// to verify the full Web Push round-trip (server → push service →
// device → SW → notification) without waiting for the next 5-min cron
// tick or for an engine state change.
//
// Gated by proxy.ts (/api/admin/:path*) so the public PWA can't trigger
// it.

import { sendPushToAll } from "@/lib/push";

export async function POST() {
  const result = await sendPushToAll({
    title: "Helios test push",
    body: "If you see this, Web Push is wired up correctly. Tap to open the Rivian app.",
    url: "rivian://",
    tag: "helios-test",
  });
  return Response.json(result);
}
