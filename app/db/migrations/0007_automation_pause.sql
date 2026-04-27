-- Add an "automation_enabled" column to user_config so the user can
-- pause Helios's actuators (Powerwall reserve writes + Rivian charging
-- schedules) without disconnecting integrations or tearing down the
-- whole engine.
--
-- Use case: pre-trip prep — user is leaving for a long trip, plans to
-- drain the Powerwall and charge the EV from the grid, doesn't want
-- the engine fighting them. Toggle off, do whatever they need
-- manually, toggle back on when they return.
--
-- Default TRUE so existing installations keep their current behavior.
-- The cron route reads this on every tick; flipping the flag takes
-- effect at most one tick (5 min) later. Snapshots continue to be
-- written either way — we want the history regardless of whether
-- the engine is acting.

ALTER TABLE user_config
  ADD COLUMN IF NOT EXISTS automation_enabled BOOLEAN NOT NULL DEFAULT TRUE;
