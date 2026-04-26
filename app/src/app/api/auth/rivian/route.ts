// Rivian connect/disconnect.
//
//   POST   /api/auth/rivian   { email, password }
//          → run the non-MFA login flow, persist tokens, pin first vehicle
//   DELETE /api/auth/rivian
//          → drop the stored token row
//
// Unlike Enphase/Smartcar/Tesla this is NOT an OAuth redirect flow —
// Rivian doesn't expose OAuth. The user types their Rivian email +
// password directly into the Helios UI; we forward to Rivian's gateway,
// keep the resulting session tokens, and discard the password
// immediately. Same trust model as the Home Assistant Rivian
// integration.

import { z } from "zod";
import { deleteToken, saveToken } from "@/lib/db";
import { getCurrentUser, loginFlow, pinVehicleId } from "@/lib/rivian";

const connectSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});

// Rivian doesn't return an explicit expires_in. Set 30 days as the
// nominal validity — refresh logic will kick in earlier if the API
// starts returning 401s. See lib/rivian/client.ts.
const NOMINAL_EXPIRY_DAYS = 30;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = connectSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  let csrf, tokens;
  try {
    ({ csrf, tokens } = await loginFlow({
      email: parsed.data.email,
      password: parsed.data.password,
    }));
  } catch (err) {
    console.error("[rivian/connect] login failed:", err);
    return Response.json(
      { error: "Login failed", message: err instanceof Error ? err.message : "unknown" },
      { status: 401 },
    );
  }

  // Persist token row before fetching the user — that way getCurrentUser()
  // can use the authedGql wrapper which reads from the DB.
  const expiresAt = new Date(Date.now() + NOMINAL_EXPIRY_DAYS * 24 * 3600 * 1000).toISOString();
  await saveToken({
    provider: "rivian",
    access_token: tokens.userSessionToken,
    refresh_token: tokens.refreshToken,
    expires_at: expiresAt,
    system_id: null,
    meta: {
      csrf_token: csrf.csrfToken,
      a_sess: csrf.appSessionToken,
      access_token: tokens.accessToken,
    },
  });

  // Pin the first vehicle so the status overlay has a target.
  let pinnedId: string | null = null;
  let pinnedSummary: string | null = null;
  try {
    const user = await getCurrentUser();
    if (user.vehicles[0]) {
      pinnedId = user.vehicles[0].id;
      pinnedSummary = `${user.vehicles[0].vehicle.modelYear} ${user.vehicles[0].vehicle.model}`;
      await pinVehicleId(pinnedId);
    }
  } catch (err) {
    console.error("[rivian/connect] vehicle pin failed:", err);
    // Token row exists; user can still retry pinning from /settings.
  }

  return Response.json({
    ok: true,
    pinned_vehicle_id: pinnedId,
    pinned_vehicle: pinnedSummary,
  });
}

export async function DELETE() {
  await deleteToken("rivian");
  return Response.json({ ok: true });
}
