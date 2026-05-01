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
import { refreshTokens } from "./auth";
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

/** Persisted state we read on every snapshot. */
type StoredAuth = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
  vehicleId: string | null;
};

async function loadAuth(): Promise<StoredAuth> {
  const tok = await getToken("smartcar");
  if (!tok) throw new SmartcarNotConfiguredError("no stored token");
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: tok.expires_at ? new Date(tok.expires_at).getTime() : 0,
    vehicleId: tok.system_id,
  };
}

/** Refresh the stored tokens via the OAuth refresh_token grant and
 *  persist. Returns the new access_token. */
async function refreshAndSave(refreshToken: string, vehicleId: string | null): Promise<string> {
  const fresh = await refreshTokens(refreshToken);
  await saveToken({
    provider: "smartcar",
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token,
    expires_at: new Date(Date.now() + fresh.expires_in * 1000).toISOString(),
    system_id: vehicleId,
    meta: null,
  });
  return fresh.access_token;
}

type FetchOpts = {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
};

/** Fetch with auto-refresh on 401. Single retry; if refresh itself
 *  fails, the original error propagates so the caller can surface a
 *  reconnect prompt. */
async function scFetch(path: string, opts: FetchOpts = {}): Promise<unknown> {
  const auth = await loadAuth();

  // Proactive refresh: if the token is within 60s of expiring, get a
  // new one before we make the call. Saves the round-trip retry.
  let accessToken = auth.accessToken;
  if (auth.expiresAt && auth.expiresAt - Date.now() < 60_000) {
    try {
      accessToken = await refreshAndSave(auth.refreshToken, auth.vehicleId);
    } catch (err) {
      console.warn("[smartcar] proactive refresh failed:", (err as Error).message);
    }
  }

  const doFetch = async (token: string): Promise<Response> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (opts.body) headers["Content-Type"] = "application/json";
    return fetch(`${hostForPath(path)}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  };

  let res = await doFetch(accessToken);
  if (res.status === 401) {
    // Reactive refresh — token expired between our check and the call,
    // or our expires_at was wrong. Try once more after refresh.
    try {
      accessToken = await refreshAndSave(auth.refreshToken, auth.vehicleId);
      res = await doFetch(accessToken);
    } catch (err) {
      throw new Error(`smartcar refresh after 401 failed: ${(err as Error).message}`);
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`smartcar ${opts.method ?? "GET"} ${path} ${res.status}: ${text}`);
  }
  return res.json();
}

// ---- Public API -----------------------------------------------------

/** GET /v3/connections — list of connections the token is authorized
 *  for. Each connection carries the vehicle UUID under
 *  relationships.vehicle.data.id. Used by the callback flow right
 *  after token exchange to discover which vehicle to pin. Returns a
 *  flat array of vehicle UUIDs to preserve the prior consumer
 *  contract. */
export async function listVehicleIds(): Promise<string[]> {
  type ConnectionsResponse = {
    data: Array<{
      id: string;
      relationships?: {
        vehicle?: { data?: { id: string } };
      };
    }>;
  };
  const json = (await scFetch("/v3/connections")) as ConnectionsResponse;
  return (json.data ?? [])
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

export async function startCharging(): Promise<SmartcarActuatorResult> {
  const auth = await loadAuth();
  if (!auth.vehicleId) {
    return { success: false, reason: "no vehicle pinned" };
  }
  try {
    const json = (await scFetch(`/v3/vehicles/${auth.vehicleId}/charge`, {
      method: "POST",
      body: { action: "START" },
    })) as SmartcarActionResponse;
    return {
      success: json.status === "success",
      status: json.status,
      requestId: json.meta?.requestId,
      reason: json.status === "success" ? undefined : `Smartcar status: ${json.status}`,
    };
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
    const json = (await scFetch(`/v3/vehicles/${auth.vehicleId}/charge`, {
      method: "POST",
      body: { action: "STOP" },
    })) as SmartcarActionResponse;
    return {
      success: json.status === "success",
      status: json.status,
      requestId: json.meta?.requestId,
      reason: json.status === "success" ? undefined : `Smartcar status: ${json.status}`,
    };
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
    const json = (await scFetch(`/v3/vehicles/${auth.vehicleId}/charge/limit`, {
      method: "POST",
      body: { limit: socPctToFraction(socPct) },
    })) as SmartcarActionResponse;
    return {
      success: json.status === "success",
      status: json.status,
      requestId: json.meta?.requestId,
      reason: json.status === "success" ? undefined : `Smartcar status: ${json.status}`,
    };
  } catch (err) {
    return {
      success: false,
      reason: err instanceof Error ? err.message : "Smartcar setChargeLimit failed",
    };
  }
}

// ---- Token persistence ----------------------------------------------

/** Persist the token bundle returned from `exchangeCode`. */
export async function saveTokens(opts: {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  vehicleId?: string | null;
}): Promise<void> {
  const existing = await getToken("smartcar");
  await saveToken({
    provider: "smartcar",
    access_token: opts.accessToken,
    refresh_token: opts.refreshToken,
    expires_at: new Date(Date.now() + opts.expiresInSec * 1000).toISOString(),
    system_id: opts.vehicleId ?? existing?.system_id ?? null,
    meta: null,
  });
}

/** Persist the pinned vehicle_id alongside existing tokens. */
export async function pinVehicleId(vehicleId: string): Promise<void> {
  const tok = await getToken("smartcar");
  if (!tok) throw new Error("cannot pin vehicle before tokens are saved");
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
