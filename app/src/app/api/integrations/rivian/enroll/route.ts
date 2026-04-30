// Rivian phone-key enrollment.
//
//   POST /api/integrations/rivian/enroll  → run the enrollment flow
//   GET  /api/integrations/rivian/enroll  → enrollment status
//
// One-time setup the admin runs after the basic OAuth-equivalent
// connect (POST /api/auth/rivian/start). Enrolls a server-side
// keypair as a "phone" against the pinned vehicle, then harvests
// the assigned vasPhoneId + identityId + vehicle's public key from
// getUserInfo and persists them into oauth_tokens.meta. The four
// fields together let stopCharging / startCharging / setChargeLimit
// sign vehicle-command HMACs.
//
// Admin-gated via proxy.ts. Refusing public access is intentional:
// successful enrollment grants whoever calls it the ability to lock
// doors, change cabin temperature, and stop/start charging on the
// real car.
//
// Side effects on the user's Rivian account:
//   - Adds an entry to enrolledPhones (visible in the Rivian app under
//     Account → Phone Keys, named "Helios").
//   - May trigger a "new device added" notification email/push.
//   - Does NOT pair via BLE — cloud commands only.
//
// If the live test in step 6 reveals BLE pairing is required for
// charging commands specifically, this endpoint stays useful (it's
// the GraphQL-side prerequisite either way) but the actuator path
// in stopCharging() will need a different approach.

import {
  enrollPhone,
  fetchEnrolledIdentity,
  getCurrentUser,
  isCommandEnrolled,
  isConfigured,
  saveCommandMeta,
} from "@/lib/rivian";
import { generateKeyPair } from "@/lib/rivian/crypto";
import { getToken } from "@/lib/db";

export async function GET() {
  const enrolled = await isCommandEnrolled();
  return Response.json({ enrolled });
}

export async function POST() {
  if (!(await isConfigured())) {
    return Response.json(
      { error: "Rivian not connected — POST /api/auth/rivian/start first" },
      { status: 400 },
    );
  }

  const tok = await getToken("rivian");
  const vehicleId = tok?.system_id;
  if (!vehicleId) {
    return Response.json(
      { error: "No vehicle pinned — reconnect to pin one" },
      { status: 400 },
    );
  }

  // Fetch user.id (the vehicleId is already pinned in the token).
  let userId: string;
  try {
    const user = await getCurrentUser();
    userId = user.id;
  } catch (err) {
    console.error("[rivian/enroll] getCurrentUser failed:", err);
    return Response.json(
      { error: "Failed to fetch Rivian user", message: errMsg(err) },
      { status: 502 },
    );
  }

  const keyPair = generateKeyPair();

  // Step 1: tell Rivian about our public key. Adds an enrolledPhones
  // entry on their side that grants this key command authority.
  let enrollSuccess: boolean;
  try {
    enrollSuccess = await enrollPhone({
      userId,
      vehicleId,
      publicKeyHex: keyPair.publicKeyHex,
      deviceName: "Helios",
    });
  } catch (err) {
    console.error("[rivian/enroll] enrollPhone failed:", err);
    return Response.json(
      { error: "EnrollPhone mutation failed", message: errMsg(err) },
      { status: 502 },
    );
  }
  if (!enrollSuccess) {
    return Response.json(
      { error: "EnrollPhone returned success: false" },
      { status: 502 },
    );
  }

  // Step 2: read back the assigned vasPhoneId + identityId, plus the
  // vehicle's public key for ECDH. If any field is missing the
  // partial state would be unusable, so we don't persist.
  const identity = await fetchEnrolledIdentity({
    vehicleId,
    ourPublicKeyHex: keyPair.publicKeyHex,
  });
  if (!identity) {
    console.error(
      "[rivian/enroll] fetchEnrolledIdentity returned null — Rivian " +
        "accepted the key but didn't surface the matching enrolledPhones " +
        "entry yet, or the vehicle has no vehiclePublicKey.",
    );
    return Response.json(
      {
        error:
          "EnrollPhone succeeded but the new key wasn't discoverable on " +
          "currentUser.enrolledPhones. Try again in 30 seconds; if the " +
          "second call still fails the account may not yet have a " +
          "vehiclePublicKey provisioned.",
      },
      { status: 502 },
    );
  }

  // Step 3: persist all four fields atomically into the existing meta blob.
  await saveCommandMeta({
    command_private_key: keyPair.privateKeyPem,
    command_vehicle_public_key: identity.vehiclePublicKey,
    command_vas_phone_id: identity.vasPhoneId,
    command_identity_id: identity.identityId,
  });

  return Response.json({
    ok: true,
    enrolled: true,
    vas_phone_id: identity.vasPhoneId,
    identity_id: identity.identityId,
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : "unknown";
}
