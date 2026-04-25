// Smartcar OAuth init + disconnect.
//
//   GET    /api/auth/smartcar  → redirect to Smartcar Connect
//   DELETE /api/auth/smartcar  → drop the stored token

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authorizeUrl } from "@/lib/smartcar";
import { deleteToken } from "@/lib/db";

const STATE_COOKIE = "smartcar_oauth_state";
const STATE_TTL_SEC = 600;

export async function GET(request: Request) {
  if (
    !process.env.SMARTCAR_APPLICATION_ID ||
    !process.env.SMARTCAR_CLIENT_ID ||
    !process.env.SMARTCAR_CLIENT_SECRET
  ) {
    return Response.json(
      {
        error:
          "SMARTCAR_APPLICATION_ID / SMARTCAR_CLIENT_ID / SMARTCAR_CLIENT_SECRET unset",
      },
      { status: 500 },
    );
  }

  const origin = new URL(request.url).origin;
  const redirectUri = `${origin}/api/auth/smartcar/callback`;
  const state = randomBytes(32).toString("hex");
  const url = authorizeUrl({ redirectUri, state });

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
  await deleteToken("smartcar");
  const store = await cookies();
  store.delete(STATE_COOKIE);
  return Response.json({ ok: true });
}
