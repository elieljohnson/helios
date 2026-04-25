// Tesla OAuth init + disconnect.
//
//   GET    /api/auth/tesla   → register partner domain (if needed),
//                              then redirect to Tesla consent page
//   DELETE /api/auth/tesla   → drop the stored token
//
// Tesla requires the app's domain to be registered via /partner_accounts
// before any user OAuth flow will succeed. registerPartnerDomain() is
// idempotent, so we call it on every init request — first time the
// account didn't exist, subsequent calls just confirm.

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authorizeUrl, registerPartnerDomain } from "@/lib/tesla";
import { deleteToken } from "@/lib/db";

const STATE_COOKIE = "tesla_oauth_state";
const STATE_TTL_SEC = 600;

export async function GET(request: Request) {
  const clientId = process.env.TESLA_CLIENT_ID;
  const clientSecret = process.env.TESLA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return Response.json(
      { error: "TESLA_CLIENT_ID / TESLA_CLIENT_SECRET unset on the server" },
      { status: 500 },
    );
  }

  const url = new URL(request.url);
  const origin = url.origin;
  const redirectUri = `${origin}/api/auth/tesla/callback`;

  // Tesla wants the registered domain (no protocol, no path). Idempotent —
  // safe to call on every request, but skip on localhost since Tesla
  // doesn't accept it as a valid partner domain.
  const hostname = url.hostname;
  if (hostname !== "localhost" && hostname !== "127.0.0.1") {
    try {
      await registerPartnerDomain({ clientId, clientSecret, domain: hostname });
    } catch (err) {
      // Log but don't fail — duplicate registration returns 4xx and that's fine.
      console.warn("[tesla/init] partner_accounts:", err);
    }
  }

  const state = randomBytes(32).toString("hex");
  const consentUrl = authorizeUrl({ clientId, redirectUri, state });

  const response = NextResponse.redirect(consentUrl, 302);
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
  await deleteToken("tesla");
  const store = await cookies();
  store.delete(STATE_COOKIE);
  return Response.json({ ok: true });
}
