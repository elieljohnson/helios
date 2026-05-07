-- Migration 0018. Adds four columns to daily_summaries that capture
-- per-day Powerwall SoC extremes — specifically the overnight low
-- and the evening-window high. Together these let future analysis
-- (and a future "learned overnight target" feature) compute the
-- night-by-night PW drain pattern:
--
--   overnight_drain_pct = evening_high_pw_pct (yesterday)
--                       − morning_low_pw_pct (today)
--
-- 2026-05-06 ad-hoc analysis showed overnight drain on this house
-- ranges 30–60% of capacity depending on usage. Capturing the
-- two endpoints daily lets us:
--
--   - track day-of-week drain patterns (weekend vs weekday)
--   - detect seasonal shifts (HVAC heating/cooling pulls)
--   - decide whether the static pw_sunset_target_pct is still
--     calibrated, or worth tightening / loosening
--   - power a future "learned overnight target" feature that sets
--     tomorrow's sunset target dynamically from rolling-30-day stats
--
-- This migration is data-capture only. The engine continues to use
-- the static pw_sunset_target_pct config field. The learned-target
-- feature will land separately once we have a few weeks of data
-- to validate the approach.

ALTER TABLE daily_summaries
  -- Lowest pw_soc observed in the morning window (PT 00:00–08:00).
  ADD COLUMN IF NOT EXISTS morning_low_pw_pct REAL,
  -- Hour PT (0–7) at which the morning low occurred. Helps spot
  -- patterns (always at 06:00 = consistent overnight bottom; later
  -- = bottom is happening past sunrise, suggests very heavy load).
  ADD COLUMN IF NOT EXISTS morning_low_at_hour_pt INT,
  -- Highest pw_soc observed in the evening window (PT 14:00–22:00).
  -- Captures the sunset peak — what PW gets to before nightfall.
  -- The engine targets pw_sunset_target_pct here; comparing this
  -- value to the configured target tells us how tightly the engine
  -- is hitting it.
  ADD COLUMN IF NOT EXISTS evening_high_pw_pct REAL,
  ADD COLUMN IF NOT EXISTS evening_high_at_hour_pt INT;

-- No new index needed — daily_summaries is already keyed on date,
-- and the queries that read these columns will be window-scans
-- (last 30 days, etc.).
