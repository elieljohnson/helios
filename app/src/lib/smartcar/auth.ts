// Smartcar auth — V3 Connect flow with V2-style OAuth code exchange.
//
// Architecture (the part that took a while to figure out):
//
//   1. Connect (user-facing) — Smartcar's V3 Connect URL takes
//      `application_id` (UUID) and redirects back with both:
//        ?code=<auth_code>      — exchange for per-vehicle access token
//        ?user_id=<UUID>        — needed for /v3/connections admin calls
//      Earlier (pre-this-fix) we thought V3 had retired the auth-code
//      step. It hadn't — V3 added the connections-management API but
//      kept the V2 vehicle-data API + token model.
//
//   2. Token exchange (server-side) — POST the code back to
//      https://auth.smartcar.com/oauth/token with HTTP Basic auth
//      (client_id + client_secret). Response contains access_token +
//      refresh_token + expires_in (typically 2h). Refresh via
//      grant_type=refresh_token using the same endpoint.
//
//   3. Vehicle data (server-side) — Bearer the access_token against
//      https://api.smartcar.com/v2.0/vehicles/{id}/... endpoints.
//      Per-vehicle scope; one access_token covers one vehicle's
//      authorized capabilities.
//
//   4. M2M application token — separate path, only needed if/when we
//      use /v3/connections for admin calls. Kept here because we may
//      want to enumerate all of a user's connections later. Not used
//      on the hot path.
//
// Env:
//   SMARTCAR_APPLICATION_ID  UUID      — Connect URL `application_id` param.
//                                       connect.smartcar.com rejects the M2M
//                                       Client ID format here; it requires the
//                                       UUID Application ID specifically.
//   SMARTCAR_CLIENT_ID       client_…  — Bearer credential at iam.smartcar.com
//                                       for the M2M client_credentials grant
//                                       (the only token grant V3 supports for
//                                       this app — no per-user OAuth tokens).
//   SMARTCAR_CLIENT_SECRET   secret    — paired with SMARTCAR_CLIENT_ID at IAM.
//   SMARTCAR_MODE            "live" | "test" (default "live").
//
// V2 holdovers kept as dead code below (exchangeCode, refreshTokens):
// V3 doesn't issue per-user tokens, so the OAuth code-exchange flow
// is unused. Functions retained briefly so a follow-up commit can
// prune them cleanly without diff noise.

const CONNECT_AUTHORIZE_URL = "https://connect.smartcar.com/oauth/authorize";
/** Unified OAuth token endpoint. V2's separate `auth.smartcar.com/oauth/token`
 *  is deprecated and rejects V3-era credentials with `invalid_client`. V3
 *  unified all three grant types (authorization_code, refresh_token,
 *  client_credentials) on iam.smartcar.com. Confirmed empirically
 *  2026-05-01 — Smartcar's own docs at api-reference/authorization/auth-code-exchange.md
 *  still point at the deprecated host, so the canonical reference is a
 *  live probe (see scripts/probe-smartcar-token-endpoints.ts). */
const TOKEN_URL = "https://iam.smartcar.com/oauth2/token";

/**
 * Informational scope list. V3 manages scope at the dashboard level
 * (Vehicle access tab) — the authorize URL doesn't carry a `scope`
 * param anymore. Listed here so other modules can introspect what the
 * application is configured for.
 */
export const SMARTCAR_SCOPES = [
  "read_battery",
  "read_charge",
  "read_vehicle_info",
  "control_charge",
] as const;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} unset`);
  return v;
}

/** Build the V3 Connect URL the user gets redirected to.
 *
 *  Uses `application_id` (the UUID Application ID), not `client_id`.
 *  Empirically 2026-05-01: connect.smartcar.com rejects
 *  `client_id=client_01...` with `400: Invalid parameter client_id`.
 *  Only the Application UUID is accepted at the Connect authorize step,
 *  even though the SDK uses `client_id` semantically — the SDK passes
 *  the UUID, not the M2M-format ID. */
export function authorizeUrl(opts: {
  redirectUri: string;
  state: string;
}): string {
  const applicationId = requireEnv("SMARTCAR_APPLICATION_ID");
  const mode = (process.env.SMARTCAR_MODE as "live" | "test") ?? "live";
  const params = new URLSearchParams({
    response_type: "code",
    application_id: applicationId,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    mode,
    // Force the consent screen even on repeat visits — useful in dev
    // and when re-OAuthing after enabling new scopes/permissions.
    approval_prompt: "force",
  });
  return `${CONNECT_AUTHORIZE_URL}?${params.toString()}`;
}

// ---- Per-vehicle OAuth tokens ---------------------------------------

export type SmartcarTokens = {
  access_token: string;
  refresh_token: string;
  /** Seconds from now; we convert to absolute expires_at on save. */
  expires_in: number;
  token_type: "Bearer";
};

function basicAuthHeader(): string {
  const id = requireEnv("SMARTCAR_CLIENT_ID");
  const secret = requireEnv("SMARTCAR_CLIENT_SECRET");
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

async function postOAuthToken(body: URLSearchParams): Promise<SmartcarTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`smartcar oauth ${res.status}: ${text}`);
  }
  return (await res.json()) as SmartcarTokens;
}

/** Exchange the `code` from Connect callback for access + refresh tokens. */
export async function exchangeCode(opts: {
  code: string;
  redirectUri: string;
}): Promise<SmartcarTokens> {
  return postOAuthToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: opts.redirectUri,
    }),
  );
}

/** Refresh an access token using a stored refresh_token. */
export async function refreshTokens(refreshToken: string): Promise<SmartcarTokens> {
  return postOAuthToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  );
}

// ---- M2M application token (admin/connections layer) ----------------

type AppToken = { token: string; expiresAt: number };
let cachedAppToken: AppToken | null = null;
const REFRESH_BUFFER_SEC = 60;

/**
 * Get a fresh-enough M2M application access token. Used only by the
 * admin layer (e.g. /v3/connections) — vehicle data calls use the
 * per-vehicle access_token from exchangeCode/refreshTokens instead.
 */
export async function getApplicationToken(): Promise<string> {
  const now = Date.now();
  if (cachedAppToken && cachedAppToken.expiresAt - REFRESH_BUFFER_SEC * 1000 > now) {
    return cachedAppToken.token;
  }
  const clientId = requireEnv("SMARTCAR_CLIENT_ID");
  const clientSecret = requireEnv("SMARTCAR_CLIENT_SECRET");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`smartcar m2m token ${res.status}: ${text}`);
  }
  const json = (await res.json()) as {
    access_token: string;
    token_type: "Bearer";
    expires_in: number;
  };
  cachedAppToken = {
    token: json.access_token,
    expiresAt: now + json.expires_in * 1000,
  };
  return cachedAppToken.token;
}

/** Test-only — clears the in-memory M2M token cache. */
export function _resetTokenCache(): void {
  cachedAppToken = null;
}
