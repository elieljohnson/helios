-- Migration 0019. Adds ev_plugged_in to the energy_snapshots row so
-- prev-tick reads via getMostRecentSnapshot() return the real value
-- instead of a hardcoded fallback.
--
-- 2026-05-06 added getMostRecentSnapshot + rowToSnapshot for the
-- trend-data infrastructure. rowToSnapshot hardcoded
-- ev_plugged_in: false because the column didn't exist. Gate 1b
-- (plug-state flap guard) reads prevSnapshot.ev_plugged_in — always
-- got back false — and fired "Plug state changed this tick" on
-- every tick when the car was plugged in. Same signature
-- noop:hold:plugged every cron tick → dedup → no activity feed
-- entry and no push. Symptom: Gate 2.5 produced the right
-- recommendation in /api/recommendation (which doesn't use prev),
-- but the cron path's pushes never reached the user.
--
-- DEFAULT TRUE so existing rows back-fill to "plugged in" — the
-- common case during charging history. For unplugged-but-historical
-- rows the value is wrong but irrelevant; Gate 1b only reads the
-- IMMEDIATELY-prior tick, and going forward writeSnapshot writes
-- the real value.

ALTER TABLE energy_snapshots
  ADD COLUMN IF NOT EXISTS ev_plugged_in BOOLEAN NOT NULL DEFAULT TRUE;
