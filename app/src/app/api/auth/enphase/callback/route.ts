// OAuth callback. Enphase redirects here with ?code=...&state=...
//
// Steps:
//   1. Verify state matches the cookie set by GET /api/auth/enphase.
//   2. Exchange code for access_token + refresh_token.
//   3. Look up the user's first system to record system_id alongside
//      the token (Enphase API calls are system-scoped).
//   4. Persist via saveToken() and bounce the user back to /settings
//      with a success flag for the UI.
//
// Errors funnel into /settings?enphase=error&reason=... so the page can
// surface what went wrong without exposing token internals.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { saveToken } from "@/lib/db";
import {
  exchangeCode,
  listSystems,
  tokenResponseToRecord,
} from "@/lib/enphase";

const STATE_COOKIE = "enphase_oauth_state";

function fail(request: Request, reason: string): Response {
  const url = new URL(`/settings?enphase=error&reason=${encodeURIComponent(reason)}`, request.url);
  return NextResponse.redirect(url, 302);
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const enphaseError = params.get("error");

  if (enphaseError) return fail(request, enphaseError);
  if (!code || !state) return fail(request, "missing-code-or-state");

  const store = await cookies();
  const expectedState = store.get(STATE_COOKIE)?.value;
  if (!expectedState || expectedState !== state) {
    return fail(request, "state-mismatch");
  }
  store.delete(STATE_COOKIE);

  const clientId = process.env.ENPHASE_CLIENT_ID;
  const clientSecret = process.env.ENPHASE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return fail(request, "server-misconfigured");

  const origin = new URL(request.url).origin;
  const redirectUri = `${origin}/api/auth/enphase/callback`;

  let tokenResp;
  try {
    tokenResp = await exchangeCode({ clientId, clientSecret, redirectUri, code });
  } catch (err) {
    console.error("[enphase/callback] exchange failed:", err);
    return fail(request, "exchange-failed");
  }

  // Stash the token first so listSystems() (which reads the token via
  // the client wrapper) has something to use.
  await saveToken(tokenResponseToRecord(tokenResp, null));

  // Best-effort system_id lookup. If it fails the token still works for
  // future calls — the user just won't have a default system pinned.
  let systemId: string | null = null;
  try {
    const systems = await listSystems();
    if (systems[0]) systemId = String(systems[0].system_id);
  } catch (err) {
    console.error("[enphase/callback] listSystems failed:", err);
  }

  if (systemId) {
    await saveToken(tokenResponseToRecord(tokenResp, systemId));
  }

  const successUrl = new URL("/settings?enphase=connected", request.url);
  return NextResponse.redirect(successUrl, 302);
}
