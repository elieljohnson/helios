// Smartcar Connect callback. Smartcar redirects back with
//   ?code=<auth_code>&user_id=<UUID>&state=<state>
//
// Sequence:
//   1. Verify state cookie (CSRF).
//   2. Exchange `code` for per-vehicle access + refresh tokens via
//      OAuth (V2 token endpoint, still authoritative under V3 Connect).
//   3. Save tokens. Resolve and pin first vehicle via /v2.0/vehicles.
//   4. Redirect back to /settings.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { exchangeCode } from "@/lib/smartcar";
import { listVehicleIds, pinVehicleId, saveTokens } from "@/lib/smartcar";

const STATE_COOKIE = "smartcar_oauth_state";

function fail(request: Request, reason: string): Response {
  const url = new URL(
    `/settings?smartcar=error&reason=${encodeURIComponent(reason)}`,
    request.url,
  );
  return NextResponse.redirect(url, 302);
}

function callbackUrl(request: Request): string {
  // Mirror authorizeUrl()'s logic — must match exactly or the token
  // exchange rejects the request.
  const url = new URL("/api/auth/smartcar/callback", request.url);
  return url.toString();
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const scError = params.get("error");

  if (scError) return fail(request, scError);
  if (!code || !state) return fail(request, "missing-code-or-state");

  const store = await cookies();
  const expectedState = store.get(STATE_COOKIE)?.value;
  if (!expectedState || expectedState !== state) {
    return fail(request, "state-mismatch");
  }
  store.delete(STATE_COOKIE);

  let tokens;
  try {
    tokens = await exchangeCode({ code, redirectUri: callbackUrl(request) });
  } catch (err) {
    console.error("[smartcar/callback] exchangeCode failed:", err);
    return fail(request, "code-exchange-failed");
  }

  await saveTokens({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresInSec: tokens.expires_in,
  });

  // Resolve and pin vehicle. Best-effort — if this fails the row
  // exists and the UI can show a "no vehicle pinned" prompt.
  try {
    const vehicleIds = await listVehicleIds();
    if (vehicleIds[0]) {
      await pinVehicleId(vehicleIds[0]);
    }
  } catch (err) {
    console.error("[smartcar/callback] listVehicleIds failed:", err);
  }

  const successUrl = new URL("/settings?smartcar=connected", request.url);
  return NextResponse.redirect(successUrl, 302);
}
