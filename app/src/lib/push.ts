// Web Push send-side. Used by cron (B4) to fan out high-priority EV
// recommendations to every subscribed device.
//
// Subscriptions live in push_subscriptions (one row per device);
// VAPID keys live in env vars (generated once via
// scripts/generate-vapid-keys.ts).
//
// Failure modes:
//   - 410 Gone / 404 Not Found → subscription is stale (user uninstalled
//     PWA, browser pruned, etc.). Delete the row so we don't keep
//     re-trying.
//   - 401 / 403 → VAPID key mismatch (rotation needed). Logs and skips.
//   - any other error → log and continue; the next high-priority
//     change will retry.

import { eq } from "drizzle-orm";
import webpush, { type PushSubscription } from "web-push";

import { pushSubscriptions } from "@/db/schema";
import { getDb } from "./db";

let _configured = false;

/** Lazy VAPID setup — called once before the first send. Idempotent. */
function ensureConfigured(): boolean {
  if (_configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!pub || !priv || !subject) {
    return false;
  }
  webpush.setVapidDetails(subject, pub, priv);
  _configured = true;
  return true;
}

export type PushPayload = {
  title: string;
  body: string;
  /** URL to open on tap. Defaults to "rivian://" in the SW. */
  url?: string;
  /** Replace-key for the lock screen — same tag → most recent wins. */
  tag?: string;
};

export type SendResult = {
  attempted: number;
  delivered: number;
  removedStale: number;
};

/** Fan-out push to every stored subscription. Returns counts for the
 *  cron's response JSON / observability. Safe to call when no
 *  subscriptions exist (returns zeros). When VAPID env vars aren't
 *  set, logs a warning and returns zeros — used in dev where push is
 *  not wired up yet. */
export async function sendPushToAll(payload: PushPayload): Promise<SendResult> {
  if (!ensureConfigured()) {
    console.warn("[push] VAPID env vars unset — skipping send.");
    return { attempted: 0, delivered: 0, removedStale: 0 };
  }
  const db = getDb();
  if (!db) {
    console.warn("[push] DB unavailable — skipping send.");
    return { attempted: 0, delivered: 0, removedStale: 0 };
  }

  const subs = await db.select().from(pushSubscriptions);
  if (subs.length === 0) {
    return { attempted: 0, delivered: 0, removedStale: 0 };
  }

  let delivered = 0;
  let removedStale = 0;
  const body = JSON.stringify(payload);

  await Promise.all(
    subs.map(async (s) => {
      const sub: PushSubscription = {
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      };
      try {
        await webpush.sendNotification(sub, body);
        delivered += 1;
        // Touch last_used_at so we can clean up long-dead subs later
        // via a maintenance job. Not awaited tightly — fire-and-forget
        // is fine for telemetry.
        void db
          .update(pushSubscriptions)
          .set({ lastUsedAt: new Date() })
          .where(eq(pushSubscriptions.endpoint, s.endpoint));
      } catch (err: unknown) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          // Subscription is gone — purge it.
          await db
            .delete(pushSubscriptions)
            .where(eq(pushSubscriptions.endpoint, s.endpoint));
          removedStale += 1;
        } else {
          console.error("[push] send failed:", status, err);
        }
      }
    }),
  );

  return { attempted: subs.length, delivered, removedStale };
}
