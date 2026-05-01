// Smartcar V3 vehicle client. Reads via the signals endpoint, actuators
// via the charge command endpoints. Both hit vehicle.api.smartcar.com.
//
// Read endpoints (V3, signals-based):
//   GET  /v3/connections              -> [{ id, attrs.vehicle, relationships.vehicle.data.id }]
//                                        Used by listVehicleIds() to harvest the vehicle UUID
//                                        after token exchange.
//   GET  /v3/vehicles/{id}            -> { id, make, model, year, mode }
//   GET  /v3/vehicles/{id}/signals    -> { data: [{ attributes: { code, body, status } }] }
//                                        Bulk endpoint — returns all signals the vehicle
//                                        exposes. Helios picks five (SoC, range, isCharging,
//                                        cable-connected, vehicle-info) and projects via
//                                        signalsToEvSnapshot() in transform.ts.
//
// Actuator endpoints (V3, synchronous):
//   POST /v3/vehicles/{id}/charge          body: {action: "START"|"STOP"}
//   POST /v3/vehicles/{id}/charge/limit    body: {limit: "0.80"}  (0..1 fraction string)
//   Response: { status: string, meta: {requestId} }
//
//   Per the 2026-05-01 strategic pivot — Rivian command path is closed
//   by BLE-pairing requirement — Smartcar V3 commands are now Helios's
//   only viable stop-authority path. Verification loop in
//   lib/verifyEvAction.ts catches "API ack but car still drawing"
//   (provider-agnostic; same shape it would have had for Rivian).
//
// V3 staleness note: signal envelopes commonly arrive with status="ERROR"
// but a non-null body containing the last cached OEM value. transform.ts
// treats ERROR-with-body as best-effort — Helios's source-status plumbing
// (StatusResponse.sources.vehicle) carries staleness up to consumers.
//
// Tokens (access_token + refresh_token) live in oauth_tokens, refreshed
// on demand when a request 401s.

import { getToken, saveToken } from "@/lib/db";
import { getApplicationToken } from "./auth";
import { signalsToEvSnapshot } from "./transform";
import type {
  SmartcarActionResponse,
  SmartcarActuatorResult,
  SmartcarEvSnapshot,
  SmartcarV3SignalsResponse,
} from "./types";

// All V3 paths route to vehicle.api.smartcar.com. The path-prefix
// helper is kept (rather than inlined) so adding any future V2 fallback
// path stays a one-line edit.
const V3_HOST = "https://vehicle.api.smartcar.com";

function hostForPath(path: string): string {
  if (path.startsWith("/v3/")) return V3_HOST;
  throw new Error(`smartcar: path "${path}" must start with /v3/`);
}

class SmartcarNotConfiguredError extends Error {
  constructor(reason: string) {
    super(`Smartcar not configured: ${reason}`);
    this.name = "SmartcarNotConfiguredError";
  }
}

/** Persisted state we read on every call.
 *
 *  V3 architecture is application-centric: the M2M token authenticates
 *  the application, and the per-user `sc-user-id` header scopes each
 *  call to a specific connection. We persist the user_id (returned by
 *  Smartcar Connect's callback as `?user_id=...`) and the vehicle_id
 *  (harvested from /v3/connections post-Connect). No per-user OAuth
 *  access/refresh tokens are needed in V3 — the legacy oauth_tokens
 *  columns access_token/refresh_token/expires_at are unused for
 *  Smartcar (kept on the row only because the schema is shared with
 *  other providers). */
type StoredAuth = {
  vehicleId: string | null;
  userId: string | null;
};

async function loadAuth(): Promise<StoredAuth> {
  const tok = await getToken("smartcar");
  if (!tok) throw new SmartcarNotConfiguredError("no stored token");
  const meta = (tok.meta as { smartcar_user_id?: string } | null) ?? {};
  return {
    vehicleId: tok.system_id,
    userId: meta.smartcar_user_id ?? null,
  };
}

type FetchOpts = {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
};

/** Make an authenticated V3 vehicle-API call. Auth pattern:
 *
 *    Authorization: Bearer ${m2m_application_token}
 *    sc-user-id:    ${user_id_from_connect_callback}
 *
 *  Smartcar enforces the user's granted scopes server-side based on
 *  the connection record (added to the application's connection list
 *  when the user completes Connect). We don't store per-user tokens. */
async function scFetch(path: string, opts: FetchOpts = {}): Promise<unknown> {
  const auth = await loadAuth();
  if (!auth.userId) {
    throw new SmartcarNotConfiguredError(
      "no smartcar_user_id stored — reconnect via Settings",
    );
  }

  const m2mToken = await getApplicationToken();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${m2mToken}`,
    "sc-user-id": auth.userId,
    Accept: "application/json",
  };
  if (opts.body) headers["Content-Type"] = "application/json";

  const res = await fetch(`${hostForPath(path)}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`smartcar ${opts.method ?? "GET"} ${path} ${res.status}: ${text}`);
  }
  return res.json();
}

// ---- Public API -----------------------------------------------------

/** GET /v3/connections — list of connections the token is authorized
 *  for. Filters to **live-mode vehicles only**, skipping simulated/test
 *  connections that may be left over from dev work. Returns a flat
 *  array of vehicle UUIDs.
 *
 *  Why filter: a Smartcar account can accumulate simulated vehicles
 *  over time (Smartcar's simulator creates them, dev work, etc.).
 *  Auto-pinning the first connection without filtering risks pointing
 *  Helios at a fake vehicle whose signals don't match the production
 *  R1S's shape — observed empirically 2026-05-01. */
export async function listVehicleIds(): Promise<string[]> {
  type ConnectionsResponse = {
    data: Array<{
      id: string;
      attributes?: { vehicle?: { mode?: string } };
      relationships?: {
        vehicle?: { data?: { id: string } };
      };
    }>;
  };
  const json = (await scFetch("/v3/connections")) as ConnectionsResponse;
  return (json.data ?? [])
    .filter((c) => c.attributes?.vehicle?.mode === "live")
    .map((c) => c.relationships?.vehicle?.data?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** GET /v3/vehicles/{id} — basic metadata. Standalone helper because
 *  the signals endpoint doesn't include make/model/year. */
async function getVehicleInfo(id: string): Promise<{
  id: string;
  make: string;
  model: string;
  year: number;
}> {
  const json = (await scFetch(`/v3/vehicles/${id}`)) as {
    data: {
      id: string;
      attributes: { make: string; model: string; year: number; mode?: string };
    };
  };
  return {
    id: json.data.id,
    make: json.data.attributes.make,
    model: json.data.attributes.model,
    year: json.data.attributes.year,
  };
}

/**
 * Aggregate EV snapshot for the cron + status assembler. Two V3 calls
 * in parallel: bulk signals + vehicle info. Projection logic lives in
 * transform.ts as a pure function.
 *
 * Returns null if the four core signals (SoC, range, isCharging,
 * cable-connected) don't all have body values. Helios's source-status
 * plumbing then marks the `vehicle` source as unavailable rather than
 * acting on a partial snapshot.
 */
export async function getEvSnapshot(): Promise<SmartcarEvSnapshot | null> {
  const auth = await loadAuth();
  if (!auth.vehicleId) return null;
  const id = auth.vehicleId;

  const [info, signalsRes] = await Promise.all([
    getVehicleInfo(id),
    scFetch(`/v3/vehicles/${id}/signals`) as Promise<SmartcarV3SignalsResponse>,
  ]);

  return signalsToEvSnapshot({
    signals: signalsRes.data ?? [],
    info: { vehicleId: info.id, make: info.make, model: info.model },
  });
}

// ---- Actuators (V3) -------------------------------------------------
//
// V3 commands live at POST /v3/vehicles/{id}/charge[/limit] under
// vehicle.api.smartcar.com (selected by hostForPath). Synchronous
// response: { status, meta.requestId }. The status string is the
// canonical diagnostic — no separate command-state endpoint exists
// in V3, unlike Rivian.
//
// Per the 2026-05-01 strategic pivot (Rivian command path closed by
// BLE-pairing requirement), Smartcar V3 is now Helios's only viable
// stop-authority path. The verification loop in lib/verifyEvAction.ts
// catches "API ack but car still drawing" — same shape it would have
// for Rivian, just consuming Smartcar's responses.
//
// Limit-conversion footgun: Smartcar's setChargeLimit takes a 0..1
// decimal fraction as a STRING ("0.80"), NOT an integer percent.
// Helios's API surface (and Rivian's) uses integer percent. Convert
// internally. socPctToFraction() is unit-tested.

/** Convert integer percent (0..100) to Smartcar's fraction string ("0.80").
 *  Clamps out-of-range inputs. Rounding to 2 decimal places matches
 *  Smartcar's documented granularity. */
export function socPctToFraction(socPct: number): string {
  const clamped = Math.max(0, Math.min(100, socPct));
  return (Math.round(clamped) / 100).toFixed(2);
}

/** V3 command-execution shape:
 *    POST /v3/vehicles/{id}/commands/charge/start  (no body)
 *    POST /v3/vehicles/{id}/commands/charge/stop   (no body)
 *  Both return { data: { id, type, attributes: { status: { value }}}}.
 *  Maps to our uniform SmartcarActuatorResult shape. */
function projectActionResponse(
  json: SmartcarActionResponse,
  failureLabel: string,
): SmartcarActuatorResult {
  const status = json.data?.attributes?.status?.value;
  return {
    success: status === "SUCCESS",
    status,
    requestId: json.data?.id,
    reason:
      status === "SUCCESS" ? undefined : `Smartcar ${failureLabel} status: ${status}`,
  };
}

export async function startCharging(): Promise<SmartcarActuatorResult> {
  const auth = await loadAuth();
  if (!auth.vehicleId) {
    return { success: false, reason: "no vehicle pinned" };
  }
  try {
    const json = (await scFetch(
      `/v3/vehicles/${auth.vehicleId}/commands/charge/start`,
      { method: "POST" },
    )) as SmartcarActionResponse;
    return projectActionResponse(json, "START");
  } catch (err) {
    return {
      success: false,
      reason: err instanceof Error ? err.message : "Smartcar START failed",
    };
  }
}

export async function stopCharging(): Promise<SmartcarActuatorResult> {
  const auth = await loadAuth();
  if (!auth.vehicleId) {
    return { success: false, reason: "no vehicle pinned" };
  }
  try {
    const json = (await scFetch(
      `/v3/vehicles/${auth.vehicleId}/commands/charge/stop`,
      { method: "POST" },
    )) as SmartcarActionResponse;
    return projectActionResponse(json, "STOP");
  } catch (err) {
    return {
      success: false,
      reason: err instanceof Error ? err.message : "Smartcar STOP failed",
    };
  }
}

/** Set the profile-level charge limit. Belt-and-suspenders companion
 *  to stopCharging — when the car is plugged in below the limit,
 *  Rivian's autonomous default is to charge to limit, so lowering the
 *  limit at-or-below current SoC closes that auto-resume window.
 *
 *  Accepts integer percent (50..100 typical). Smartcar's API takes
 *  a 0..1 fraction string; conversion handled here. */
export async function setChargeLimit(socPct: number): Promise<SmartcarActuatorResult> {
  const auth = await loadAuth();
  if (!auth.vehicleId) {
    return { success: false, reason: "no vehicle pinned" };
  }
  try {
    // V3 set-charge-limit takes an INTEGER percent (50..100) wrapped
    // in a JSON:API envelope, not the V2-style decimal fraction.
    // socPctToFraction() / the "0..1 string" pattern is V2 only.
    const clamped = Math.max(50, Math.min(100, Math.round(socPct)));
    const json = (await scFetch(
      `/v3/vehicles/${auth.vehicleId}/commands/charge/set-limit`,
      {
        method: "POST",
        body: { data: { attributes: { percent: clamped } } },
      },
    )) as SmartcarActionResponse;
    return projectActionResponse(json, "SET_CHARGE_LIMIT");
  } catch (err) {
    return {
      success: false,
      reason: err instanceof Error ? err.message : "Smartcar setChargeLimit failed",
    };
  }
}

// ---- Connection persistence -----------------------------------------
//
// V3 doesn't issue per-user access/refresh tokens, so the row stores
// only what V3's auth pattern needs:
//   - system_id            = vehicle_id (UUID, harvested from /v3/connections)
//   - meta.smartcar_user_id = user_id (returned by Connect's callback)
//
// The legacy access_token/refresh_token/expires_at columns are
// populated with empty/zero values to satisfy the shared schema; nothing
// in the V3 client reads them. They can be cleaned up in a follow-up
// schema migration.

/** Persist the user_id from Smartcar Connect's callback. Optional
 *  vehicleId can be pinned at the same time; otherwise it stays null
 *  until pinVehicleId() resolves it from /v3/connections. */
export async function saveConnection(opts: {
  userId: string;
  vehicleId?: string | null;
}): Promise<void> {
  const existing = await getToken("smartcar");
  await saveToken({
    provider: "smartcar",
    access_token: "", // unused under V3 M2M auth
    refresh_token: "", // unused under V3 M2M auth
    // schema requires non-null expires_at; V3 doesn't expire per-user
    // tokens (there are none), so use a far-future placeholder. Cleanup
    // when the schema is migrated to allow null on this column.
    expires_at: "2099-01-01T00:00:00.000Z",
    system_id: opts.vehicleId ?? existing?.system_id ?? null,
    meta: { smartcar_user_id: opts.userId },
  });
}

/** Backwards-compatible alias for the V2-era saveTokens shape. The
 *  callback handler uses this to drop in the new flow without changing
 *  its import; the access/refresh token args are ignored under V3. */
export async function saveTokens(opts: {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  vehicleId?: string | null;
  userId?: string | null;
}): Promise<void> {
  if (!opts.userId) {
    throw new Error("saveTokens called without userId — V3 requires user_id");
  }
  await saveConnection({ userId: opts.userId, vehicleId: opts.vehicleId });
}

/** Persist the pinned vehicle_id alongside the existing connection row. */
export async function pinVehicleId(vehicleId: string): Promise<void> {
  const tok = await getToken("smartcar");
  if (!tok) throw new Error("cannot pin vehicle before connection is saved");
  await saveToken({ ...tok, system_id: vehicleId });
}

export async function isConfigured(): Promise<boolean> {
  if (
    !process.env.SMARTCAR_APPLICATION_ID ||
    !process.env.SMARTCAR_CLIENT_ID ||
    !process.env.SMARTCAR_CLIENT_SECRET
  ) {
    return false;
  }
  const tok = await getToken("smartcar");
  return !!tok;
}
