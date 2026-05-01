// POST /api/push/subscribe
//
// Body: a serialized PushSubscription from pushManager.subscribe() —
//   { endpoint, keys: { p256dh, auth } }
// plus optional userAgent for debugging.
//
// Upserts on endpoint (PK), so re-subscribing from the same device
// updates rather than duplicates. Idempotent.

import { sql } from "drizzle-orm";

import { pushSubscriptions } from "@/db/schema";
import { getDb } from "@/lib/db";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const sub = body as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
    userAgent?: string;
  };

  if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
    return Response.json(
      { error: "missing endpoint/keys.p256dh/keys.auth" },
      { status: 400 },
    );
  }

  const db = getDb();
  if (!db) {
    return Response.json({ error: "db unavailable" }, { status: 503 });
  }

  await db
    .insert(pushSubscriptions)
    .values({
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      userAgent: sub.userAgent ?? null,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent: sub.userAgent ?? null,
        lastUsedAt: sql`NULL`,
      },
    });

  return Response.json({ ok: true });
}
