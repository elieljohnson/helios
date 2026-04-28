// Server-side admin check. Reads the helios_admin cookie and compares
// it to ADMIN_TOKEN. Used by route handlers that want to redact
// sensitive fields for unauthenticated callers (vs. the proxy.ts gate
// which 401s the whole request).
//
// In dev (ADMIN_TOKEN unset), treats every caller as admin — same
// pattern as proxy.ts and CRON_SECRET. Local dev shows the full
// payload without manual setup.

import { cookies } from "next/headers";

export async function isAdmin(): Promise<boolean> {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return true; // dev escape hatch
  const c = await cookies();
  return c.get("helios_admin")?.value === expected;
}
