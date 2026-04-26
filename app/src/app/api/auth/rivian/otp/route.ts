// Rivian connect — step 2: OTP submission.
//
// Reads the HELIOS_RIVIAN_MFA cookie set by /start, calls Rivian's
// loginWithOTP mutation with the saved otpToken + email + the user-
// supplied OTP code, persists tokens, pins the first vehicle, clears
// the cookie. Errors surface as 400 (bad code), 401 (otp expired /
// rejected), or 410 (cookie missing — start step never run).

import { z } from "zod";
import { cookies } from "next/headers";
import { submitOtp } from "@/lib/rivian";
import { fetchVehicleSummary, persistAndPin } from "../start/route";

const schema = z.object({
  otp_code: z
    .string()
    .regex(/^\d{4,8}$/u, "OTP must be 4–8 digits"),
});

const MFA_COOKIE = "HELIOS_RIVIAN_MFA";

type MfaCookieValue = { e: string; o: string; c: string; a: string };

function decodeMfaCookie(raw: string): MfaCookieValue | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf-8");
    const obj = JSON.parse(json) as Partial<MfaCookieValue>;
    if (!obj.e || !obj.o || !obj.c || !obj.a) return null;
    return obj as MfaCookieValue;
  } catch {
    return null;
  }
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

  const store = await cookies();
  const raw = store.get(MFA_COOKIE)?.value;
  if (!raw) {
    return Response.json(
      { error: "MFA session missing or expired. Restart connect from email + password." },
      { status: 410 },
    );
  }
  const state = decodeMfaCookie(raw);
  if (!state) {
    return Response.json({ error: "MFA cookie malformed" }, { status: 410 });
  }

  let tokens;
  try {
    tokens = await submitOtp({
      email: state.e,
      otpCode: parsed.data.otp_code,
      otpToken: state.o,
      csrf: { csrfToken: state.c, appSessionToken: state.a },
    });
  } catch (err) {
    console.error("[rivian/otp] submitOtp failed:", err);
    const msg = err instanceof Error ? err.message : "unknown";
    // Rivian responds with a generic GQL error on bad/expired OTP;
    // surface it as a 401 so the UI can show "wrong code, try again".
    return Response.json({ error: "OTP rejected", message: msg }, { status: 401 });
  }

  await persistAndPin({
    csrfToken: state.c,
    appSessionToken: state.a,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    userSessionToken: tokens.userSessionToken,
  });
  const summary = await fetchVehicleSummary();

  // OTP step succeeded — clear the cookie. Use the same path the cookie
  // was set on so the deletion lands.
  store.delete({ name: MFA_COOKIE, path: "/api/auth/rivian" });

  return Response.json({ ok: true, ...summary });
}
