-- 0013_push_subscriptions.sql
--
-- Web Push subscriptions. One row per (browser, device) — the standard
-- pushManager.subscribe() returns a unique endpoint per device, which
-- we use as the primary key.
--
-- Helios's notification model under Option B (locked 2026-05-01): the
-- decision engine surfaces stop/start as recommendations and pushes
-- the high-priority ones to the user's phone. The user actuates via
-- the Rivian app — the push body is a 1-tap link.
--
-- Lifecycle:
--   - inserted on POST /api/push/subscribe (PWA call after user grants
--     Notification permission)
--   - deleted on POST /api/push/unsubscribe
--   - deleted server-side on 404/410 from the push service (subscription
--     went stale — phone lost, browser uninstalled, etc.)

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint     TEXT PRIMARY KEY,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
