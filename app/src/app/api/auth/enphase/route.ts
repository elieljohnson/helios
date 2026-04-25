// Enphase OAuth init + disconnect.
//
//   GET    /api/auth/enphase   → redirect to Enphase consent page
//   DELETE /api/auth/enphase   → drop the stored token
//
// The redirect_uri is derived from the incoming request's origin so the
// same app credentials work in dev (localhost:3000) and production
// (helios-eeg1.vercel.app). Both URIs must be registered with the
// Enphase developer app.

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authorizeUrl } from "@/lib/enphase";
import { deleteToken } from "@/lib/db";

const STATE_COOKIE = "enphase_oauth_state";
const STATE_TTL_SEC = 600; // 10 min — user shouldn't take longer to consent

export async function GET(request: Request) {
  const clientId = process.env.ENPHASE_CLIENT_ID;
  if (!clientId) {
    return Response.json(
      { error: "ENPHASE_CLIENT_ID is unset on the server" },
      { status: 500 },
    );
  }

  const origin = new URL(request.url).origin;
  const redirectUri = `${origin}/api/auth/enphase/callback`;
  const state = randomBytes(32).toString("hex");
  const url = authorizeUrl({ clientId, redirectUri, state });

  const response = NextResponse.redirect(url, 302);
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: origin.startsWith("https://"),
    sameSite: "lax",
    path: "/",
    maxAge: STATE_TTL_SEC,
  });
  return response;
}

export async function DELETE() {
  await deleteToken("enphase");
  // Best-effort: also clear any leftover state cookie.
  const store = await cookies();
  store.delete(STATE_COOKIE);
  return Response.json({ ok: true });
}
