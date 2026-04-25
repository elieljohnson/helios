// Enphase API request wrapper. Auto-refreshes the access token when it's
// within REFRESH_BUFFER_SEC of expiry (or after a 401 from a bad assumption).
// Throws if no token is stored — callers handle that as "unconfigured."
//
// Two credentials are required on every call (Enphase's design):
//   - Authorization: Bearer <access_token>  — user-scoped OAuth
//   - key: <api_key>                         — application-scoped throttle key

import { getToken, saveToken } from "@/lib/db";
import { refreshAccessToken, tokenResponseToRecord } from "./auth";
import type { EnphaseSummary, EnphaseSystem, EnphaseSystemsResponse } from "./types";

const BASE_URL = "https://api.enphaseenergy.com/api/v4";
const REFRESH_BUFFER_SEC = 5 * 60; // refresh 5 min before expiry

class EnphaseNotConfiguredError extends Error {
  constructor(reason: string) {
    super(`Enphase not configured: ${reason}`);
    this.name = "EnphaseNotConfiguredError";
  }
}

export const ENPHASE_NOT_CONFIGURED = "EnphaseNotConfiguredError";

function envOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new EnphaseNotConfiguredError(`${name} is unset`);
  return v;
}

async function getValidAccessToken(): Promise<{ access: string; systemId: string | null }> {
  const tok = await getToken("enphase");
  if (!tok) throw new EnphaseNotConfiguredError("no stored token (connect via OAuth)");

  const expiresMs = new Date(tok.expires_at).getTime();
  const nearExpiry = Date.now() > expiresMs - REFRESH_BUFFER_SEC * 1000;

  if (!nearExpiry) {
    return { access: tok.access_token, systemId: tok.system_id };
  }

  const clientId = envOrThrow("ENPHASE_CLIENT_ID");
  const clientSecret = envOrThrow("ENPHASE_CLIENT_SECRET");
  const fresh = await refreshAccessToken({
    clientId,
    clientSecret,
    refreshToken: tok.refresh_token,
  });
  const next = tokenResponseToRecord(fresh, tok.system_id);
  await saveToken(next);
  return { access: next.access_token, systemId: next.system_id };
}

async function enphaseFetch<T>(path: string): Promise<T> {
  const apiKey = envOrThrow("ENPHASE_API_KEY");
  const { access } = await getValidAccessToken();

  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${access}`,
      key: apiKey,
      accept: "application/json",
    },
    // Enphase summary updates every ~5 min; cache a minute server-side.
    next: { revalidate: 60 },
  });

  if (res.status === 401) {
    // Stale token slipped past the buffer. Force-refresh once.
    const tok = await getToken("enphase");
    if (!tok) throw new EnphaseNotConfiguredError("token vanished mid-request");
    const fresh = await refreshAccessToken({
      clientId: envOrThrow("ENPHASE_CLIENT_ID"),
      clientSecret: envOrThrow("ENPHASE_CLIENT_SECRET"),
      refreshToken: tok.refresh_token,
    });
    await saveToken(tokenResponseToRecord(fresh, tok.system_id));
    const retry = await fetch(url, {
      headers: {
        authorization: `Bearer ${fresh.access_token}`,
        key: apiKey,
        accept: "application/json",
      },
    });
    if (!retry.ok) {
      throw new Error(`Enphase ${path} retry ${retry.status}: ${await retry.text()}`);
    }
    return (await retry.json()) as T;
  }

  if (!res.ok) {
    throw new Error(`Enphase ${path} ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

// --- public surface --------------------------------------------------

export async function listSystems(): Promise<EnphaseSystem[]> {
  const resp = await enphaseFetch<EnphaseSystemsResponse>("/systems");
  return resp.systems;
}

export async function getSummary(systemId: string): Promise<EnphaseSummary> {
  return enphaseFetch<EnphaseSummary>(`/systems/${systemId}/summary`);
}

/** True if both env credentials and a stored token exist. */
export async function isConfigured(): Promise<boolean> {
  if (!process.env.ENPHASE_CLIENT_ID || !process.env.ENPHASE_CLIENT_SECRET || !process.env.ENPHASE_API_KEY) {
    return false;
  }
  const tok = await getToken("enphase");
  return !!tok;
}
