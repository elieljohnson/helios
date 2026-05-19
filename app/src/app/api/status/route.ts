import { isAdmin } from "@/lib/auth";
import { cached } from "@/lib/cache";
import { assembleStatus } from "@/lib/status";

// Composed snapshot. Starts from the validated mock; every connected
// provider overlays its fields. `sources` tells the UI which fields
// are live vs. mocked.
//
// For unauthenticated callers (the public portfolio demo) we redact
// `system.coords` — the lat/lng are precise enough to identify the
// home address, which we don't need to expose to recruiters who just
// want to see the dashboard.
//
// 10s in-process cache around assembleStatus(): absorbs burst polls
// (page load, multi-device overlap) without lying about freshness
// during a real provider outage. The full status with coords is
// cached once; per-call redaction strips coords for non-admin
// callers. See app/src/lib/cache.ts for the TTL rationale.
export async function GET() {
  const status = await cached("status:full", 10_000, () => assembleStatus());
  if (await isAdmin()) {
    return Response.json(status);
  }
  // Strip lat/lng. Everything else (location string, hardware specs,
  // power flows, SoCs, costs) stays — that's the demo value.
  const { coords, ...systemRedacted } = status.system;
  void coords;
  return Response.json({
    ...status,
    system: systemRedacted,
  });
}
