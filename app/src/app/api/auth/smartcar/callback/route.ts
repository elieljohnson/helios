// Smartcar Connect callback. Smartcar redirects back with
//   ?code=<auth_code>&user_id=<UUID>&state=<state>
//
// V3 sequence (post-2026-05-01 architecture pivot):
//   1. Verify state cookie (CSRF).
//   2. Save the user_id from the query params. (The `code` is
//      ignored — V3 doesn't issue per-user OAuth tokens; vehicle-API
//      calls authenticate via the application's M2M token + sc-user-id
//      header instead.)
//   3. Resolve and pin the first vehicle via /v3/connections, which
//      uses M2M auth and sc-user-id, so it's reachable as soon as the
//      user_id is persisted.
//   4. Redirect back to /settings.
//
// V2 fields the URL still carries (`code`, redirect_uri matching) are
// no-ops under V3. Kept for compatibility with the Connect URL the
// authorize endpoint generates — Smartcar still issues a code as part
// of the Connect flow even though we don't exchange it.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { listVehicleIds, pinVehicleId, saveConnection } from "@/lib/smartcar";

const STATE_COOKIE = "smartcar_oauth_state";

function fail(request: Request, reason: string): Response {
  const url = new URL(
    `/settings?smartcar=error&reason=${encodeURIComponent(reason)}`,
    request.url,
  );
  return NextResponse.redirect(url, 302);
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const userId = params.get("user_id");
  const state = params.get("state");
  const scError = params.get("error");

  if (scError) return fail(request, scError);
  if (!userId || !state) return fail(request, "missing-user-id-or-state");

  const store = await cookies();
  const expectedState = store.get(STATE_COOKIE)?.value;
  if (!expectedState || expectedState !== state) {
    return fail(request, "state-mismatch");
  }
  store.delete(STATE_COOKIE);

  // Persist the user_id first; listVehicleIds() needs it to authenticate
  // the /v3/connections call (M2M token + sc-user-id header).
  await saveConnection({ userId });

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
