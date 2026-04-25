// Smartcar V2 vehicle client — the actual vehicle data API lives here,
// not at the V3 host. (Took us a while to figure that out; see auth.ts
// header for the full breakdown.) One per-vehicle access token covers
// all of a vehicle's authorized capabilities.
//
//   GET  /v2.0/vehicles                       -> list vehicle IDs for this token
//   GET  /v2.0/vehicles/{id}                  -> { id, make, model, year }
//   GET  /v2.0/vehicles/{id}/battery          -> { range, percentRemaining }
//   GET  /v2.0/vehicles/{id}/charge           -> { state, isPluggedIn }
//   POST /v2.0/vehicles/{id}/charge/start     -> { status }
//   POST /v2.0/vehicles/{id}/charge/stop      -> { status }
//
// Tokens (access_token + refresh_token) live in oauth_tokens, refreshed
// on demand when a request 401s.

import { getToken, saveToken } from "@/lib/db";
import { refreshTokens } from "./auth";
import type { SmartcarEvSnapshot } from "./types";

const VEHICLE_API_BASE = "https://api.smartcar.com/v2.0";

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
    return fetch(`${VEHICLE_API_BASE}${path}`, {
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

/** GET /v2.0/vehicles — list of vehicle IDs the token is authorized for.
 *  Used by the callback flow right after token exchange to discover
 *  which vehicle to pin. */
export async function listVehicleIds(): Promise<string[]> {
  const json = (await scFetch("/vehicles")) as {
    vehicles: string[];
    paging?: { count: number; offset: number };
  };
  return json.vehicles ?? [];
}

/**
 * Aggregate EV snapshot for the cron + status assembler. Three V2
 * calls in parallel: vehicle info (make/model/year), battery (SoC +
 * range), charge (isCharging + isPluggedIn).
 */
export async function getEvSnapshot(): Promise<SmartcarEvSnapshot | null> {
  const auth = await loadAuth();
  if (!auth.vehicleId) return null;
  const id = auth.vehicleId;

  const [info, battery, charge] = await Promise.all([
    scFetch(`/vehicles/${id}`) as Promise<{
      id: string;
      make: string;
      model: string;
      year: number;
    }>,
    scFetch(`/vehicles/${id}/battery`) as Promise<{
      percentRemaining: number;
      range: number;
    }>,
    scFetch(`/vehicles/${id}/charge`) as Promise<{
      isPluggedIn: boolean;
      state: string;
    }>,
  ]);

  return {
    vehicleId: info.id,
    make: info.make,
    model: info.model,
    // Smartcar emits SoC as 0..1 in V2; convert to 0..100 integer.
    soc: Math.round((battery.percentRemaining ?? 0) * 100),
    rangeMiles: Math.round(battery.range ?? 0),
    isPluggedIn: charge.isPluggedIn === true,
    isCharging: charge.state === "CHARGING",
  };
}

/** POST /vehicles/{id}/charge/start — actually start the charger. */
export async function startCharging(): Promise<{ ok: boolean; status: string }> {
  const auth = await loadAuth();
  if (!auth.vehicleId) throw new Error("no vehicle pinned");
  const json = (await scFetch(`/vehicles/${auth.vehicleId}/charge/start`, {
    method: "POST",
  })) as { status: string };
  return { ok: json.status === "success", status: json.status };
}

/** POST /vehicles/{id}/charge/stop — halt charging. */
export async function stopCharging(): Promise<{ ok: boolean; status: string }> {
  const auth = await loadAuth();
  if (!auth.vehicleId) throw new Error("no vehicle pinned");
  const json = (await scFetch(`/vehicles/${auth.vehicleId}/charge/stop`, {
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
