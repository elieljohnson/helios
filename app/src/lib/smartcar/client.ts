// Smartcar V3 vehicle client (read-side migrated 2026-05-01; actuators
// still V2-style — see TODO V3 markers below).
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
// Actuator endpoints (still V2-style — TODO V3 migration):
//   POST /v2.0/vehicles/{id}/charge/start  -> { status }
//   POST /v2.0/vehicles/{id}/charge/stop   -> { status }
//
//   These calls will FAIL after the user's first V3-era reconnect because
//   the new tokens won't have V2-route capability. They're left in place
//   as a placeholder — the next migration pass replaces them with the V3
//   command-shape (likely POST /v3/vehicles/{id}/commands/charge with a
//   body, but verify in the V3 docs first; charge-state mutations may
//   live under a different surface entirely).
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
import type { SmartcarEvSnapshot, SmartcarV3SignalsResponse } from "./types";

// V2 and V3 live on different hosts. Path prefix selects which.
//   /v3/...   → https://vehicle.api.smartcar.com  (V3 reads via signals)
//   /v2.0/... → https://api.smartcar.com          (V2 actuators, dormant pending V3 migration)
const V2_HOST = "https://api.smartcar.com";
const V3_HOST = "https://vehicle.api.smartcar.com";

function hostForPath(path: string): string {
  if (path.startsWith("/v3/")) return V3_HOST;
  if (path.startsWith("/v2.0/")) return V2_HOST;
  throw new Error(`smartcar: path "${path}" must start with /v3/ or /v2.0/`);
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

// ---- Actuators (still V2 — TODO V3 migration) -----------------------
//
// The two actuator paths below remain on the V2 host. They will FAIL
// after the user's first V3-era reconnect because new tokens won't
// carry V2 capability. Migration scope is documented in
// docs/smartcar-integration-handoff.md (step 3 of the next-session
// plan); deferred so we can verify V3 reads work end-to-end before
// committing to actuator-shape choices.
//
// Until migration: these throw on call. Cron's fireEvAction handles
// the throw and logs "Smartcar: <message>" in the activity feed, same
// as any other actuator failure. Helios production currently routes
// stops through Rivian, not Smartcar, so this isn't a regression — it
// just makes the dormant fallback path's broken-ness honest.

/** TODO V3: replace with V3 command shape. POST /v2.0/vehicles/{id}/charge/start
 *  is no longer a valid path under V3-era tokens. */
export async function startCharging(): Promise<{ ok: boolean; status: string }> {
  const auth = await loadAuth();
  if (!auth.vehicleId) throw new Error("no vehicle pinned");
  const json = (await scFetch(`/v2.0/vehicles/${auth.vehicleId}/charge/start`, {
    method: "POST",
  })) as { status: string };
  return { ok: json.status === "success", status: json.status };
}

/** TODO V3: replace with V3 command shape. */
export async function stopCharging(): Promise<{ ok: boolean; status: string }> {
  const auth = await loadAuth();
  if (!auth.vehicleId) throw new Error("no vehicle pinned");
  const json = (await scFetch(`/v2.0/vehicles/${auth.vehicleId}/charge/stop`, {
    method: "POST",
  })) as { status: string };
  return { ok: json.status === "success", status: json.status };
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
