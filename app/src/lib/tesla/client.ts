// Tesla Fleet API request wrapper. Mirrors the shape of lib/enphase/client
// so the provider-composition layer in lib/status.ts stays uniform.
//
// Key differences from Enphase:
//   - One credential per call (Bearer access_token); no extra api_key
//   - 8-hour access tokens (vs Enphase's 24h) → refresh more often
//   - Reserve write returns a small JSON ack with the applied value

import { getToken, saveToken } from "@/lib/db";
import {
  refreshAccessToken,
  TESLA_API_BASE,
  tokenResponseToRecord,
} from "./auth";
import type {
  TeslaLiveStatus,
  TeslaLiveStatusResponse,
  TeslaProduct,
  TeslaProductsResponse,
  TeslaSiteInfo,
  TeslaSiteInfoResponse,
} from "./types";

const REFRESH_BUFFER_SEC = 5 * 60; // refresh 5 min before expiry
// Tesla rate limit is ~200 req / 15min. live_status updates only every
// few seconds anyway; cache 5 min to keep us comfortably under budget.
const FETCH_REVALIDATE_SEC = 300;

class TeslaNotConfiguredError extends Error {
  constructor(reason: string) {
    super(`Tesla not configured: ${reason}`);
    this.name = "TeslaNotConfiguredError";
  }
}

export const TESLA_NOT_CONFIGURED = "TeslaNotConfiguredError";

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new TeslaNotConfiguredError(`${name} is unset`);
  return v;
}

async function getValidAccessToken(): Promise<{ access: string; systemId: string | null }> {
  const tok = await getToken("tesla");
  if (!tok) throw new TeslaNotConfiguredError("no stored token (connect via OAuth)");

  const expiresMs = new Date(tok.expires_at).getTime();
  const nearExpiry = Date.now() > expiresMs - REFRESH_BUFFER_SEC * 1000;

  if (!nearExpiry) {
    return { access: tok.access_token, systemId: tok.system_id };
  }

  const clientId = envOrThrow("TESLA_CLIENT_ID");
  const fresh = await refreshAccessToken({
    clientId,
    refreshToken: tok.refresh_token,
  });
  const next = tokenResponseToRecord(fresh, tok.system_id);
  await saveToken(next);
  return { access: next.access_token, systemId: next.system_id };
}

async function teslaFetch<T>(
  path: string,
  init?: { method?: string; body?: string; cache?: boolean },
): Promise<T> {
  const { access } = await getValidAccessToken();
  const url = `${TESLA_API_BASE}${path}`;
  const useCache = init?.cache !== false && !init?.method;

  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${access}`,
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
    body: init?.body,
    next: useCache ? { revalidate: FETCH_REVALIDATE_SEC } : { revalidate: 0 },
  });

  if (res.status === 401) {
    // Stale token slipped past the buffer. Force-refresh once.
    const tok = await getToken("tesla");
    if (!tok) throw new TeslaNotConfiguredError("token vanished mid-request");
    const fresh = await refreshAccessToken({
      clientId: envOrThrow("TESLA_CLIENT_ID"),
      refreshToken: tok.refresh_token,
    });
    await saveToken(tokenResponseToRecord(fresh, tok.system_id));
    const retry = await fetch(url, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${fresh.access_token}`,
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
      body: init?.body,
    });
    if (!retry.ok) {
      throw new Error(`Tesla ${path} retry ${retry.status}: ${await retry.text()}`);
    }
    return (await retry.json()) as T;
  }

  if (!res.ok) {
    throw new Error(`Tesla ${path} ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// --- public surface --------------------------------------------------

export async function listProducts(): Promise<TeslaProduct[]> {
  const resp = await teslaFetch<TeslaProductsResponse>("/api/1/products");
  return resp.response;
}

export async function getLiveStatus(siteId: string): Promise<TeslaLiveStatus> {
  const resp = await teslaFetch<TeslaLiveStatusResponse>(
    `/api/1/energy_sites/${siteId}/live_status`,
  );
  return resp.response;
}

export async function getSiteInfo(siteId: string): Promise<TeslaSiteInfo> {
  const resp = await teslaFetch<TeslaSiteInfoResponse>(
    `/api/1/energy_sites/${siteId}/site_info`,
  );
  return resp.response;
}

/** Set the Powerwall backup_reserve_percent. The actuator the decision
 *  engine has been logging — now real. Bypasses cache. */
export async function setBackupReserve(siteId: string, pct: number): Promise<{ ok: boolean }> {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  const resp = await teslaFetch<{ response: { code: number; message: string } }>(
    `/api/1/energy_sites/${siteId}/backup`,
    {
      method: "POST",
      body: JSON.stringify({ backup_reserve_percent: clamped }),
      cache: false,
    },
  );
  // Tesla returns { response: { code: 201, message: "..." } } on success.
  return { ok: resp.response.code === 201 || resp.response.code === 200 };
}

/** True if both env credentials and a stored token exist. */
export async function isConfigured(): Promise<boolean> {
  if (!process.env.TESLA_CLIENT_ID || !process.env.TESLA_CLIENT_SECRET) {
    return false;
  }
  const tok = await getToken("tesla");
  return !!tok;
}
