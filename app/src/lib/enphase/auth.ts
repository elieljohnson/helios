// Enphase Enlighten v4 OAuth 2.0 — authorization-code flow.
//
//   1. Helios redirects the user to AUTHORIZE_URL with our client_id +
//      redirect_uri. They log in to enphaseenergy.com and consent.
//   2. Enphase redirects back to our /api/auth/enphase/callback with
//      ?code=... — we exchange that for an access_token + refresh_token.
//   3. Subsequent API calls send Bearer access_token AND a separate
//      `key: <api_key>` header (Enphase's quirky two-credential model).
//   4. Refresh tokens last ~1 week; access tokens ~1 day. The client
//      wrapper auto-refreshes when expires_at < now.
//
// Docs: https://developer-v4.enphase.com/docs/quickstart.html

import type { EnphaseTokenResponse } from "./types";
import type { OAuthTokenRecord } from "@/lib/db";

const AUTHORIZE_URL = "https://api.enphaseenergy.com/oauth/authorize";
const TOKEN_URL = "https://api.enphaseenergy.com/oauth/token";

export function authorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", opts.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("state", opts.state);
  return u.toString();
}

function basicAuth(clientId: string, clientSecret: string): string {
  return "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

export async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<EnphaseTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: basicAuth(opts.clientId, opts.clientSecret),
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Enphase token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as EnphaseTokenResponse;
}

export async function refreshAccessToken(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<EnphaseTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: basicAuth(opts.clientId, opts.clientSecret),
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Enphase token refresh failed (${res.status}): ${text}`);
  }
  return (await res.json()) as EnphaseTokenResponse;
}

/** Build an OAuthTokenRecord from a fresh token response. */
export function tokenResponseToRecord(
  resp: EnphaseTokenResponse,
  systemId: string | null,
): OAuthTokenRecord {
  const expiresAt = new Date(Date.now() + resp.expires_in * 1000).toISOString();
  return {
    provider: "enphase",
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    expires_at: expiresAt,
    system_id: systemId,
    meta: resp.scope ? { scope: resp.scope } : null,
  };
}
