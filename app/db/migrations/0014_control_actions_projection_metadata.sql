-- Migration 0014. Adds structured projection-metadata columns to
-- control_actions so future trend screens can query the engine's
-- decision context as data, not as parsed free-text reason.
--
-- All columns nullable: pre-existing rows stay valid, and decision
-- types other than EV charging (reserve writes, info, alert) leave
-- them unset.

ALTER TABLE control_actions
  ADD COLUMN IF NOT EXISTS zone TEXT
    CHECK (zone IS NULL OR zone IN ('comfort', 'caution', 'defend')),
  ADD COLUMN IF NOT EXISTS ev_charge_limit_pct REAL,
  ADD COLUMN IF NOT EXISTS projected_end_pw_pct REAL,
  ADD COLUMN IF NOT EXISTS projected_departure_pw_pct REAL,
  ADD COLUMN IF NOT EXISTS mode TEXT
    CHECK (mode IS NULL OR mode IN ('parked', 'driving'));

-- Index on zone for "how often did defend zone refuse this month"
-- style queries. Partial index — most rows are NULL so we skip them.
CREATE INDEX IF NOT EXISTS idx_actions_zone
  ON control_actions (zone, occurred_at DESC)
  WHERE zone IS NOT NULL;
