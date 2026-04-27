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
  SET_CHARGING_SCHEDULES_MUTATION,
  createCsrfTokens,
} from "./auth";
import type {
  RivianChargingSchedule,
  RivianCurrentUser,
  RivianEvSnapshot,
  RivianUserVehicle,
  RivianVehicleState,
  RivianWeekDay,
} from "./types";

const VEHICLE_STATE_QUERY = `query GetVehicleState($vehicleID: String!) {
  vehicleState(id: $vehicleID) {
    __typename
    batteryLevel { __typename timeStamp value }
    batteryLimit { __typename timeStamp value }
    distanceToEmpty { __typename timeStamp value }
    chargerState { __typename timeStamp value }
    chargerStatus { __typename timeStamp value }
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

  return { soc, targetPct, rangeMiles, isCharging, isPluggedIn };
}

/** True if a Rivian token row exists (and meta is shaped correctly). */
export async function isConfigured(): Promise<boolean> {
  const tok = await getToken("rivian");
  if (!tok) return false;
  const meta = tok.meta as { csrf_token?: string; a_sess?: string } | null;
  return !!(meta?.csrf_token && meta?.a_sess);
}

// ---- Charging actuator ----------------------------------------------

/** Voltage assumption for amps↔kW conversion. Matches the Tesla
 *  Universal WC's reported grid_v on US split-phase 240V installs.
 *  If we ever serve regions on different voltages, lift to system
 *  config. */
const NOMINAL_VOLTAGE = 240;

const PT_WEEKDAY_NAMES: RivianWeekDay[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Local-time weekday + minutes-after-midnight for the user's home
 *  timezone. Rivian charging schedules are anchored to the car's
 *  reported timezone, which for a Mill Valley-pinned car is
 *  America/Los_Angeles. */
function ptWeekdayAndMinutes(now: Date): { weekDay: RivianWeekDay; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";
  const minStr = parts.find((p) => p.type === "minute")?.value ?? "0";
  const idx =
    { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd] ?? 1;
  return {
    weekDay: PT_WEEKDAY_NAMES[idx],
    minutes: parseInt(hourStr, 10) * 60 + parseInt(minStr, 10),
  };
}

/** Submit a (possibly empty) array of schedules. Empty array clears
 *  all schedules — that's how we "stop charging now." */
export async function setChargingSchedule(
  vehicleId: string,
  schedules: RivianChargingSchedule[],
): Promise<{ success: boolean }> {
  const data = await authedGql<{ setChargingSchedules: { success: boolean } }>({
    operationName: "SetChargingSchedule",
    query: SET_CHARGING_SCHEDULES_MUTATION,
    variables: { vehicleId, chargingSchedules: schedules },
  });
  return data.setChargingSchedules;
}

/** Start charging now for `durationHours` at up to `rateKw`. The car
 *  will draw at most `amperage` amps during the window; if solar +
 *  PW can't sustain that, the car silently throttles down. The
 *  weekDays array is just today — schedules without `weekDays`
 *  matching today's local weekday are dormant. */
export async function startCharging(opts: {
  rateKw: number;
  durationHours: number;
  coords: { lat: number; lng: number };
  now?: Date;
}): Promise<{ success: boolean; amperage: number; durationMinutes: number }> {
  const auth = await readAuth();
  if (!auth.vehicleId) throw new RivianNotConfiguredError("no vehicle pinned");

  const now = opts.now ?? new Date();
  const { weekDay, minutes } = ptWeekdayAndMinutes(now);
  // Start one minute in the past so the schedule is immediately active
  // — Rivian evaluates startTime ≤ now < startTime + duration.
  const startTime = Math.max(0, minutes - 1);
  const durationMinutes = Math.max(1, Math.round(opts.durationHours * 60));
  // Clamp to 0–48 A. Universal WC max is 48 A; values above that will
  // be silently capped by the car. Clamping below for safety against
  // engine bugs that might send a negative budget through.
  const amperage = Math.max(
    0,
    Math.min(48, Math.floor((opts.rateKw * 1000) / NOMINAL_VOLTAGE)),
  );

  const schedule: RivianChargingSchedule = {
    weekDays: [weekDay],
    startTime,
    duration: durationMinutes,
    location: { latitude: opts.coords.lat, longitude: opts.coords.lng },
    amperage,
    enabled: true,
  };
  const result = await setChargingSchedule(auth.vehicleId, [schedule]);
  return { ...result, amperage, durationMinutes };
}

/** Stop charging now. Rivian's mutation rejects an empty schedules
 *  array (BAD_REQUEST_ERROR / INVALID_INPUT — verified via probe), so
 *  we send a single sentinel schedule with `enabled: false` instead.
 *  Effect: no active charging schedule applies, the car returns to
 *  its default (idle) behavior. */
export async function stopCharging(opts?: {
  coords?: { lat: number; lng: number };
}): Promise<{ success: boolean }> {
  const auth = await readAuth();
  if (!auth.vehicleId) throw new RivianNotConfiguredError("no vehicle pinned");
  // Coords are part of the InputChargingSchedule type but irrelevant
  // here since enabled=false; default to (0, 0) if caller didn't pass.
  const lat = opts?.coords?.lat ?? 0;
  const lng = opts?.coords?.lng ?? 0;
  const sentinel: RivianChargingSchedule = {
    weekDays: ["Monday"],
    startTime: 0,
    duration: 0,
    location: { latitude: lat, longitude: lng },
    amperage: 0,
    enabled: false,
  };
  return setChargingSchedule(auth.vehicleId, [sentinel]);
}
