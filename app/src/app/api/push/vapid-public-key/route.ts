// Returns the VAPID public key the PWA needs for pushManager.subscribe().
// Public by design — the public key is meant to be distributed; only
// the private key is sensitive.

export async function GET() {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) {
    return Response.json(
      { error: "push not configured (VAPID_PUBLIC_KEY unset)" },
      { status: 503 },
    );
  }
  return Response.json({ vapidPublicKey: key });
}
