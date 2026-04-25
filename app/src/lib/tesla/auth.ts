// Tesla Fleet OAuth 2.0 — authorization-code flow.
//
// One important Tesla quirk: before any user OAuth flow can succeed, the
// app's domain must be registered with Tesla via /api/1/partner_accounts
// using a **partner-level** access token (one obtained with
// grant_type=client_credentials, not from a user). registerPartnerDomain()
// below handles that one-time setup.
//
// Token TTL: access ~8h, refresh tokens are long-lived and reusable.
// Token issuer: https://auth.tesla.com (separate host from the API host
// at https://fleet-api.prd.na.vn.cloud.tesla.com).
//
// Docs: https://developer.tesla.com/docs/fleet-api/authentication

import type { OAuthTokenRecord } from "@/lib/db";
import type { TeslaPartnerAccountResponse, TeslaTokenResponse } from "./types";

export const TESLA_AUTH_URL = "https://auth.tesla.com/oauth2/v3/authorize";
export const TESLA_TOKEN_URL = "https://auth.tesla.com/oauth2/v3/token";
// Helios's Powerwalls are in North America; Tesla regionalizes the API
// host. Keep this aligned with the partner-account region.
export const TESLA_API_BASE = "https://fleet-api.prd.na.vn.cloud.tesla.com";

export const TESLA_SCOPES = [
  "openid",
  "offline_access",
  "energy_device_data",
  "energy_cmds",
] as const;

export function authorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const u = new URL(TESLA_AUTH_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("scope", TESLA_SCOPES.join(" "));
  u.searchParams.set("state", opts.state);
  // Forces the consent screen even if the user previously authorized —
  // useful while iterating on scope changes during development.
  u.searchParams.set("prompt", "login");
  return u.toString();
}

export async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<TeslaTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    scope: TESLA_SCOPES.join(" "),
    code: opts.code,
  });
  const res = await fetch(TESLA_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Tesla token exchange failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as TeslaTokenResponse;
}

export async function refreshAccessToken(opts: {
  clientId: string;
  refreshToken: string;
}): Promise<TeslaTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: opts.clientId,
    refresh_token: opts.refreshToken,
    // Tesla recommends echoing the original scope set on refresh.
    scope: TESLA_SCOPES.join(" "),
  });
  const res = await fetch(TESLA_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Tesla token refresh failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as TeslaTokenResponse;
}

/** Get a partner-level (client_credentials) token. Used only for the
 *  one-time domain registration; users authorize with the user-level
 *  flow above. Tesla does not return a refresh_token here. */
async function getPartnerToken(opts: {
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    scope: TESLA_SCOPES.join(" "),
    audience: TESLA_API_BASE,
  });
  const res = await fetch(TESLA_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Tesla partner token failed (${res.status}): ${await res.text()}`);
  }
  const j = (await res.json()) as TeslaTokenResponse;
  return j.access_token;
}

/** Register our domain with Tesla so its OAuth consent page accepts it.
 *  Idempotent — safe to call repeatedly. Tesla expects the public key to
 *  be hosted at /.well-known/appspecific/com.tesla.3p.public-key.pem on
 *  the registered domain, but for energy-only scopes (no vehicle commands)
 *  the public-key requirement is waived. */
export async function registerPartnerDomain(opts: {
  clientId: string;
  clientSecret: string;
  domain: string;
}): Promise<TeslaPartnerAccountResponse> {
  const token = await getPartnerToken({
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
  });
  const res = await fetch(`${TESLA_API_BASE}/api/1/partner_accounts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ domain: opts.domain }),
  });
  if (!res.ok) {
    throw new Error(`Tesla partner_accounts ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as TeslaPartnerAccountResponse;
}

export function tokenResponseToRecord(
  resp: TeslaTokenResponse,
  systemId: string | null,
): OAuthTokenRecord {
  const expiresAt = new Date(Date.now() + resp.expires_in * 1000).toISOString();
  return {
    provider: "tesla",
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    expires_at: expiresAt,
    system_id: systemId,
    meta: resp.scope ? { scope: resp.scope } : null,
  };
}
