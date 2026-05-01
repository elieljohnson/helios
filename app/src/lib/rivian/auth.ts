// Rivian auth — unofficial GraphQL gateway.
//
// Flow (non-MFA path; Helios doesn't currently surface an OTP screen):
//
//   1. POST createCsrfToken         → csrfToken, appSessionToken
//   2. POST Login(email, password)  → accessToken, refreshToken, userSessionToken
//      Headers: a-sess, csrf-token, apollographql-client-name
//
// The user session token (u-sess) is the long-lived credential we
// store and pass to vehicle queries. The CSRF + app-session pair is
// kept in `meta` because every API call needs all three headers.
//
// ToS posture: this is the same endpoint Rivian's mobile app uses;
// reverse-engineered from public observation. Single-tenant personal
// use is a tolerated norm in the EV-data community. Multi-tenant or
// commercial deployment would warrant explicit dialogue with Rivian.

import type {
  RivianCsrfTokens,
  RivianLoginResponse,
  RivianLoginTokens,
  RivianMfaChallenge,
} from "./types";

export const RIVIAN_GATEWAY_URL = "https://rivian.com/api/gql/gateway/graphql";

/** Mimic the Rivian Android app per community convention. Rivian's
 *  gateway gates anonymous logins on this header value; using a
 *  generic UA risks being silently rate-limited. */
export const RIVIAN_CLIENT_NAME = "com.rivian.android.consumer";
export const RIVIAN_USER_AGENT = "RivianApp/3038 CFNetwork/1390 Darwin/22.0.0";

const CSRF_MUTATION = `mutation CreateCSRFToken { createCsrfToken { __typename csrfToken appSessionToken } }`;

const LOGIN_MUTATION = `mutation Login($email: String!, $password: String!) {
  login(email: $email, password: $password) {
    __typename
    ... on MobileLoginResponse { accessToken refreshToken userSessionToken }
    ... on MobileMFALoginResponse { otpToken }
  }
}`;

const LOGIN_WITH_OTP_MUTATION = `mutation LoginWithOTP($email: String!, $otpCode: String!, $otpToken: String!) {
  loginWithOTP(email: $email, otpCode: $otpCode, otpToken: $otpToken) {
    __typename accessToken refreshToken userSessionToken
  }
}`;

/** Charging schedule mutation. Unlike sendVehicleCommand (which is
 *  HMAC-signed via VAS phone keys), this one accepts plain authed
 *  GraphQL — the user-session + CSRF + app-session triple is enough.
 *  Empty schedules array clears all schedules → effective "stop now". */
export const SET_CHARGING_SCHEDULES_MUTATION = `mutation SetChargingSchedule($vehicleId: String!, $chargingSchedules: [InputChargingSchedule!]!) {
  setChargingSchedules(vehicleId: $vehicleId, chargingSchedules: $chargingSchedules) {
    success
  }
}`;

type GqlError = { message: string; extensions?: Record<string, unknown> };

async function gql<T>(opts: {
  operationName: string;
  query: string;
  variables: Record<string, unknown>;
  headers?: Record<string, string>;
}): Promise<T> {
  const res = await fetch(RIVIAN_GATEWAY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "apollographql-client-name": RIVIAN_CLIENT_NAME,
      "user-agent": RIVIAN_USER_AGENT,
      ...opts.headers,
    },
    body: JSON.stringify({
      operationName: opts.operationName,
      query: opts.query,
      variables: opts.variables,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Rivian ${opts.operationName} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  let parsed: { data?: T; errors?: GqlError[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Rivian ${opts.operationName} non-JSON: ${text.slice(0, 200)}`);
  }
  if (parsed.errors?.length) {
    throw new Error(
      `Rivian ${opts.operationName} GQL error: ${parsed.errors.map((e) => e.message).join("; ")}`,
    );
  }
  if (!parsed.data) throw new Error(`Rivian ${opts.operationName} returned no data`);
  return parsed.data;
}

/** Step 1: mint CSRF + app-session tokens. No auth required. */
export async function createCsrfTokens(): Promise<RivianCsrfTokens> {
  const data = await gql<{ createCsrfToken: { csrfToken: string; appSessionToken: string } }>({
    operationName: "CreateCSRFToken",
    query: CSRF_MUTATION,
    variables: {},
  });
  return {
    csrfToken: data.createCsrfToken.csrfToken,
    appSessionToken: data.createCsrfToken.appSessionToken,
  };
}

/** Step 2: log in with email + password. Returns tokens directly on
 *  non-MFA accounts, or an OTP challenge token if MFA is enabled. */
export async function login(opts: {
  email: string;
  password: string;
  csrf: RivianCsrfTokens;
}): Promise<RivianLoginResponse> {
  const data = await gql<{ login: { __typename: string } & Record<string, unknown> }>({
    operationName: "Login",
    query: LOGIN_MUTATION,
    variables: { email: opts.email, password: opts.password },
    headers: {
      "a-sess": opts.csrf.appSessionToken,
      "csrf-token": opts.csrf.csrfToken,
    },
  });

  const r = data.login;
  if (r.__typename === "MobileMFALoginResponse") {
    return { otpToken: r.otpToken as string } satisfies RivianMfaChallenge;
  }
  if (r.__typename === "MobileLoginResponse") {
    return {
      accessToken: r.accessToken as string,
      refreshToken: r.refreshToken as string,
      userSessionToken: r.userSessionToken as string,
    } satisfies RivianLoginTokens;
  }
  throw new Error(`Rivian Login: unexpected __typename ${r.__typename}`);
}

/** Step 3 (when MFA is required): submit the OTP code Rivian emailed
 *  the user. otpToken comes from the prior login response; it pairs
 *  with the code Rivian sent. */
export async function submitOtp(opts: {
  email: string;
  otpCode: string;
  otpToken: string;
  csrf: RivianCsrfTokens;
}): Promise<RivianLoginTokens> {
  const data = await gql<{ loginWithOTP: { accessToken: string; refreshToken: string; userSessionToken: string } }>({
    operationName: "LoginWithOTP",
    query: LOGIN_WITH_OTP_MUTATION,
    variables: { email: opts.email, otpCode: opts.otpCode, otpToken: opts.otpToken },
    headers: {
      "a-sess": opts.csrf.appSessionToken,
      "csrf-token": opts.csrf.csrfToken,
    },
  });
  return {
    accessToken: data.loginWithOTP.accessToken,
    refreshToken: data.loginWithOTP.refreshToken,
    userSessionToken: data.loginWithOTP.userSessionToken,
  };
}

/** Convenience: non-MFA login chain. Returns the MFA branch unchanged
 *  so callers can decide how to surface OTP entry. */
export async function loginFlow(opts: {
  email: string;
  password: string;
}): Promise<
  | { mfa: false; csrf: RivianCsrfTokens; tokens: RivianLoginTokens }
  | { mfa: true; csrf: RivianCsrfTokens; otpToken: string }
> {
  const csrf = await createCsrfTokens();
  const result = await login({ email: opts.email, password: opts.password, csrf });
  if ("otpToken" in result) {
    return { mfa: true, csrf, otpToken: result.otpToken };
  }
  return { mfa: false, csrf, tokens: result };
}
