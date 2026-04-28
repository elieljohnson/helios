// POST /api/admin/logout
//
// Clears the helios_admin cookie. Always returns 200 — logging out an
// already-logged-out caller is a no-op, not an error.

import { cookies } from "next/headers";

export async function POST() {
  const c = await cookies();
  c.set("helios_admin", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  return Response.json({ ok: true });
}
