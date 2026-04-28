// GET /api/me
//
// Returns { admin: boolean }. Used by the client to decide whether the
// Settings UI renders editable inputs or a read-only demo view.
//
// Stays out of the auth middleware matcher — it's intentionally public so
// unauthenticated visitors get a clean { admin: false } answer instead of
// a 401 they'd have to handle as a special case.

import { cookies } from "next/headers";

export async function GET() {
  const expected = process.env.ADMIN_TOKEN;

  // Dev mode (no ADMIN_TOKEN set): the cookie may be the placeholder "dev"
  // from /api/admin/login, or absent. Either way, treat the caller as
  // admin since the middleware doesn't gate anything in dev.
  if (!expected) {
    return Response.json({ admin: true, dev: true });
  }

  const c = await cookies();
  const cookie = c.get("helios_admin")?.value;
  return Response.json({ admin: cookie === expected });
}
