// Enphase API request wrapper. Auto-refreshes the access token when it's
// within REFRESH_BUFFER_SEC of expiry (or after a 401 from a bad assumption).
// Throws if no token is stored — callers handle that as "unconfigured."
//
// Two credentials are required on every call (Enphase's design):
//   - Authorization: Bearer <access_token>  — user-scoped OAuth
//   - key: <api_key>                         — application-scoped throttle key

import { getToken, saveToken } from "@/lib/db";
import { refreshAccessToken, tokenResponseToRecord } from "./auth";
import type {
  EnphaseSummary,
  EnphaseSystem,
  EnphaseSystemsResponse,
  EnphaseTelemetryResponse,
} from "./types";

const BASE_URL = "https://api.enphaseenergy.com/api/v4";
const REFRESH_BUFFER_SEC = 5 * 60; // refresh 5 min before expiry
// Enphase Watt (free) plan is **1,000 hits per MONTH** — not per day.
// The Envoy-S itself only reports new telemetry every 15 min, so a
// shorter cache window just burns quota on duplicate upstream data.
// 15-min revalidate caps per-endpoint usage at ~96 fetches/day or
// ~2,880/month, which is still over the free quota with a busy
// dashboard, but it's the floor before live-data freshness suffers.
// Burning the rest of the budget is what hitting the dashboard
// frequently looks like; the 15-min refresh is the right knob, the
// quota itself is the constraint. Tesla Fleet API supplies solar as
// a fallback during quota exhaustion (already used for the cron
// path via assembleStatus({forEngine: true})).
const FETCH_REVALIDATE_SEC = 15 * 60;
// Time bucket used to stabilize timestamp-based query strings so
// they hit the fetch cache instead of generating a new URL every
// second. See getConsumptionPower for why this matters.
const QUERY_BUCKET_SEC = 15 * 60;

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
    next: { revalidate: FETCH_REVALIDATE_SEC },
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

/** Latest 15-min consumption interval converted to average watts. Returns
 *  null when no interval is available.
 *
 *  Important: Enphase's consumption telemetry requires an **Envoy-S
 *  Metered with consumption CT clamps installed at the main panel**.
 *  Production-only systems (like the Mill Valley reference) return
 *  `total_devices: 0` and an empty intervals array — we'll get null and
 *  the caller falls back to whatever else can supply home_w (mock for
 *  now, eventually Tesla Powerwall which has its own consumption
 *  measurement). The code is correct; the hardware just isn't there. */
export async function getConsumptionPower(systemId: string): Promise<number | null> {
  // Look back 2 hours so we always have a populated interval. Enphase
  // returns intervals chronologically; we want the freshest.
  //
  // Critical detail: round startAt to QUERY_BUCKET_SEC so consecutive
  // calls within the same window produce the same URL and hit Next.js's
  // fetch cache. Without this, startAt ticks every second and every
  // call generates a unique URL — the `next: { revalidate }` setting
  // can't help because the cache keys on URL. This was burning the
  // Watt plan's 1,000/month quota fast (629 hits in 30 days observed
  // pre-fix vs. ~96/day theoretical max post-fix).
  const nowS = Math.floor(Date.now() / 1000);
  const bucketStart = Math.floor(nowS / QUERY_BUCKET_SEC) * QUERY_BUCKET_SEC;
  const startAt = bucketStart - 2 * 3600;
  const path = `/systems/${systemId}/telemetry/consumption_meter?granularity=15mins&start_at=${startAt}`;
  const resp = await enphaseFetch<EnphaseTelemetryResponse>(path);
  const intervals = resp.intervals ?? [];
  // Walk backwards for the most recent interval that has data.
  for (let i = intervals.length - 1; i >= 0; i--) {
    const iv = intervals[i];
    if (typeof iv.powr === "number") return Math.round(iv.powr);
    if (typeof iv.enwh === "number") {
      // 15-min interval = 0.25h. enwh / 0.25 = average watts.
      return Math.round(iv.enwh * 4);
    }
  }
  return null;
}

/** True if both env credentials and a stored token exist. */
export async function isConfigured(): Promise<boolean> {
  if (!process.env.ENPHASE_CLIENT_ID || !process.env.ENPHASE_CLIENT_SECRET || !process.env.ENPHASE_API_KEY) {
    return false;
  }
  const tok = await getToken("enphase");
  return !!tok;
}
