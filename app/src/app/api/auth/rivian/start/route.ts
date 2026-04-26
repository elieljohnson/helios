// Rivian connect — step 1: email + password.
//
// Two-step because Rivian challenges every new IP/device with an OTP.
// This route does the CSRF + Login pair; if MFA is required (the common
// case from server IPs), it stashes the otpToken + csrf in a short-
// lived HTTP-only cookie and returns { mfa_required: true } so the UI
// can prompt for the code. The follow-up /api/auth/rivian/otp route
// reads the cookie and completes login via submitOtp.
//
// Cookie design:
//   - httpOnly + secure + sameSite=lax — standard CSRF posture
//   - maxAge 300 (5 min) — Rivian OTPs typically expire ~10 min so
//     this is comfortably tighter
//   - value = base64url(JSON.stringify({ email, otpToken, csrf, app_sess }))
//   - cookie name: HELIOS_RIVIAN_MFA
//
// No signing/encryption: the cookie is only useful in conjunction with
// the OTP code Rivian emails the user, so a stolen cookie alone can't
// impersonate. httpOnly blocks JS read.

import { z } from "zod";
import { cookies } from "next/headers";
import { saveToken } from "@/lib/db";
import { getCurrentUser, loginFlow, pinVehicleId } from "@/lib/rivian";

const schema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});

const MFA_COOKIE = "HELIOS_RIVIAN_MFA";
const MFA_COOKIE_TTL_SEC = 300;
const NOMINAL_EXPIRY_DAYS = 30;

type MfaCookieValue = {
  e: string; // email
  o: string; // otpToken
  c: string; // csrfToken
  a: string; // appSessionToken
};

function encodeMfaCookie(v: MfaCookieValue): string {
  return Buffer.from(JSON.stringify(v), "utf-8").toString("base64url");
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  let flow;
  try {
    flow = await loginFlow({
      email: parsed.data.email,
      password: parsed.data.password,
    });
  } catch (err) {
    console.error("[rivian/start] login failed:", err);
    return Response.json(
      { error: "Login failed", message: err instanceof Error ? err.message : "unknown" },
      { status: 401 },
    );
  }

  // ---- MFA branch: stash state in cookie, ask UI for OTP ----
  if (flow.mfa) {
    const cookieValue = encodeMfaCookie({
      e: parsed.data.email,
      o: flow.otpToken,
      c: flow.csrf.csrfToken,
      a: flow.csrf.appSessionToken,
    });
    const isHttps = new URL(request.url).protocol === "https:";
    const store = await cookies();
    store.set(MFA_COOKIE, cookieValue, {
      httpOnly: true,
      secure: isHttps,
      sameSite: "lax",
      path: "/api/auth/rivian",
      maxAge: MFA_COOKIE_TTL_SEC,
    });
    return Response.json({ mfa_required: true });
  }

  // ---- No-MFA branch: save tokens, pin vehicle ----
  await persistAndPin({
    csrfToken: flow.csrf.csrfToken,
    appSessionToken: flow.csrf.appSessionToken,
    accessToken: flow.tokens.accessToken,
    refreshToken: flow.tokens.refreshToken,
    userSessionToken: flow.tokens.userSessionToken,
  });
  const summary = await fetchVehicleSummary();
  return Response.json({ ok: true, ...summary });
}

/** Shared persistence path used by /start (non-MFA branch) and /otp.
 *  Saves the token row and best-effort pins the first vehicle. */
export async function persistAndPin(t: {
  csrfToken: string;
  appSessionToken: string;
  accessToken: string;
  refreshToken: string;
  userSessionToken: string;
}): Promise<void> {
  const expiresAt = new Date(Date.now() + NOMINAL_EXPIRY_DAYS * 24 * 3600 * 1000).toISOString();
  await saveToken({
    provider: "rivian",
    access_token: t.userSessionToken,
    refresh_token: t.refreshToken,
    expires_at: expiresAt,
    system_id: null,
    meta: {
      csrf_token: t.csrfToken,
      a_sess: t.appSessionToken,
      access_token: t.accessToken,
    },
  });
}

export async function fetchVehicleSummary(): Promise<{
  pinned_vehicle_id: string | null;
  pinned_vehicle: string | null;
}> {
  try {
    const user = await getCurrentUser();
    const v = user.vehicles[0];
    if (!v) return { pinned_vehicle_id: null, pinned_vehicle: null };
    await pinVehicleId(v.id);
    return {
      pinned_vehicle_id: v.id,
      pinned_vehicle: `${v.vehicle.modelYear} ${v.vehicle.model}`,
    };
  } catch (err) {
    console.error("[rivian/start] vehicle summary failed:", err);
    return { pinned_vehicle_id: null, pinned_vehicle: null };
  }
}
