// Rivian API client wrapper.
//
// Mirrors lib/tesla/client and lib/smartcar/client: a single authed
// fetch helper that pulls tokens from the DB row, calls the Rivian
// GraphQL gateway with all four required headers, and exposes typed
// query helpers (currentUser, vehicleState).
//
// Token model (stored in oauth_tokens row, provider="rivian"):
//   access_token  → userSessionToken     (passed as `u-sess`)
//   refresh_token → refreshToken         (for future refresh mutation)
//   system_id     → pinned vehicle UUID  (currentUser.vehicles[*].id)
//   meta          → { csrf_token, a_sess, access_token } — short-lived
//                   tokens that travel alongside u-sess. Re-minted on
//                   401 by re-running createCsrfTokens.
//
// The community-documented refreshAccessToken mutation isn't yet in
// the public docs, so for now: on 401 we mark the integration as
// needing reconnect rather than silently re-minting via stored
// password (which we deliberately don't store).

import { getToken, saveToken } from "../db";
import {
  RIVIAN_CLIENT_NAME,
  RIVIAN_GATEWAY_URL,
  RIVIAN_USER_AGENT,
  createCsrfTokens,
} from "./auth";
import type {
  RivianCurrentUser,
  RivianEvSnapshot,
  RivianUserVehicle,
  RivianVehicleState,
} from "./types";

const VEHICLE_STATE_QUERY = `query GetVehicleState($vehicleID: String!) {
  vehicleState(id: $vehicleID) {
    __typename
    batteryLevel { __typename timeStamp value }
    batteryLimit { __typename timeStamp value }
    distanceToEmpty { __typename timeStamp value }
    chargerState { __typename timeStamp value }
    chargerStatus { __typename timeStamp value }
    gnssLocation { __typename timeStamp value { latitude longitude } }
  }
}`;

const CURRENT_USER_QUERY = `query CurrentUserForLogin {
  currentUser {
    __typename
    id email firstName lastName
    vehicles {
      id vin
      vehicle { model modelYear }
    }
  }
}`;

class RivianNotConfiguredError extends Error {
  constructor(reason: string) {
    super(`Rivian not configured: ${reason}`);
    this.name = "RivianNotConfiguredError";
  }
}

type StoredAuth = {
  uSess: string;
  aSess: string;
  csrf: string;
  refresh: string;
  vehicleId: string | null;
};

async function readAuth(): Promise<StoredAuth> {
  const tok = await getToken("rivian");
  if (!tok) throw new RivianNotConfiguredError("no stored token (connect via /settings)");
  const meta = (tok.meta as { csrf_token?: string; a_sess?: string } | null) ?? {};
  if (!meta.csrf_token || !meta.a_sess) {
    throw new RivianNotConfiguredError("token row missing csrf/a_sess in meta");
  }
  return {
    uSess: tok.access_token,
    aSess: meta.a_sess,
    csrf: meta.csrf_token,
    refresh: tok.refresh_token,
    vehicleId: tok.system_id,
  };
}

type GqlError = { message: string; extensions?: Record<string, unknown> };

/** Authenticated GraphQL call. Auto-refreshes the CSRF/app-session
 *  pair on 401 (those rotate independently of the user session). On
 *  unrecoverable failure throws — caller decides whether to mark the
 *  integration as needing reconnect. */
async function authedGql<T>(opts: {
  operationName: string;
  query: string;
  variables: Record<string, unknown>;
}): Promise<T> {
  let auth = await readAuth();

  const call = async (a: StoredAuth) => {
    const res = await fetch(RIVIAN_GATEWAY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "apollographql-client-name": RIVIAN_CLIENT_NAME,
        "user-agent": RIVIAN_USER_AGENT,
        "a-sess": a.aSess,
        "u-sess": a.uSess,
        "csrf-token": a.csrf,
      },
      body: JSON.stringify({
        operationName: opts.operationName,
        query: opts.query,
        variables: opts.variables,
      }),
    });
    return res;
  };

  let res = await call(auth);

  // CSRF/app-session can roll without invalidating the user session.
  // Re-mint and retry once before giving up.
  if (res.status === 401 || res.status === 403) {
    try {
      const fresh = await createCsrfTokens();
      const tok = await getToken("rivian");
      if (tok) {
        await saveToken({
          ...tok,
          meta: {
            ...((tok.meta as Record<string, unknown> | null) ?? {}),
            csrf_token: fresh.csrfToken,
            a_sess: fresh.appSessionToken,
          },
        });
        auth = { ...auth, csrf: fresh.csrfToken, aSess: fresh.appSessionToken };
        res = await call(auth);
      }
    } catch (err) {
      console.error("[rivian] csrf re-mint failed:", err);
    }
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Rivian ${opts.operationName} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const parsed = JSON.parse(text) as { data?: T; errors?: GqlError[] };
  if (parsed.errors?.length) {
    throw new Error(
      `Rivian ${opts.operationName} GQL error: ${parsed.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (!parsed.data) throw new Error(`Rivian ${opts.operationName} no data`);
  return parsed.data;
}

// ---- public surface --------------------------------------------------

/** Return the user's profile + vehicle list. Used during connect to
 *  pin the first vehicle, and surfaced on /settings later for choice. */
export async function getCurrentUser(): Promise<RivianCurrentUser> {
  const data = await authedGql<{ currentUser: RivianCurrentUser }>({
    operationName: "CurrentUserForLogin",
    query: CURRENT_USER_QUERY,
    variables: {},
  });
  return data.currentUser;
}

/** Pin a vehicle ID to the stored token (single-vehicle MVP). */
export async function pinVehicleId(vehicleId: string): Promise<void> {
  const tok = await getToken("rivian");
  if (!tok) throw new RivianNotConfiguredError("can't pin — no token");
  await saveToken({ ...tok, system_id: vehicleId });
}

export async function listVehicles(): Promise<RivianUserVehicle[]> {
  const u = await getCurrentUser();
  return u.vehicles;
}

/** Fetch live vehicle state and project to Helios's snapshot shape. */
export async function getEvSnapshot(): Promise<RivianEvSnapshot | null> {
  const auth = await readAuth();
  if (!auth.vehicleId) return null;

  const data = await authedGql<{ vehicleState: RivianVehicleState }>({
    operationName: "GetVehicleState",
    query: VEHICLE_STATE_QUERY,
    variables: { vehicleID: auth.vehicleId },
  });

  const s = data.vehicleState;
  // Rivian reports SoC as a float (e.g. 59.4); we floor-int it for
  // display since Helios's contract has ev_soc as integer percent.
  const soc = Math.floor(s.batteryLevel.value);
  const targetPct = Math.floor(s.batteryLimit?.value ?? 80);
  const rangeMiles = Math.floor(s.distanceToEmpty.value);
  const chargerState = s.chargerState.value;
  const chargerStatus = s.chargerStatus.value;
  const isCharging = chargerState === "charging_active";
  const isPluggedIn =
    chargerStatus === "chrgr_sts_connected_charging" ||
    chargerStatus === "chrgr_sts_connected_no_chrg" ||
    chargerStatus === "chrgr_sts_connected_chrg_complete";

  // GNSS location is optional — old accounts and vehicles in deep
  // sleep may not return it. When present, plumb lat/lng/timestamp
  // through so the engine's geofence gate can consult them.
  const gnss = s.gnssLocation;
  const lat = gnss?.value?.latitude;
  const lng = gnss?.value?.longitude;
  const locationAt = gnss?.timeStamp;

  return {
    soc,
    targetPct,
    rangeMiles,
    isCharging,
    isPluggedIn,
    ...(typeof lat === "number" && typeof lng === "number"
      ? { lat, lng, locationAt }
      : {}),
  };
}

/** True if a Rivian token row exists (and meta is shaped correctly). */
export async function isConfigured(): Promise<boolean> {
  const tok = await getToken("rivian");
  if (!tok) return false;
  const meta = tok.meta as { csrf_token?: string; a_sess?: string } | null;
  return !!(meta?.csrf_token && meta?.a_sess);
}

