// Rivian disconnect.
//
//   DELETE /api/auth/rivian → drop the stored token row
//
// The connect path lives at /api/auth/rivian/start (email + password)
// and /api/auth/rivian/otp (OTP code) — Rivian challenges every new
// IP with MFA, so connect is always two-step from the prod UI.

import { deleteToken } from "@/lib/db";

export async function DELETE() {
  await deleteToken("rivian");
  return Response.json({ ok: true });
}
