-- Migration 0017. Enriches daily_summaries with the columns needed
-- for the trend-screen panels we plan to build (per-card historical
-- views: solar production, cost over time, charging metrics with
-- source split, Powerwall flow attribution).
--
-- All columns nullable initially: the rollup writer (rollupYesterday
-- in db.ts) populates them going forward; pre-existing rows (if
-- any) stay valid.
--
-- The rollup runs at the first cron tick after PT midnight. It
-- integrates the previous day's energy_snapshots into one summary
-- row, attributes EV draw and PW flow to sources using the same
-- proportional algorithm used for sessions, and stamps in actual
-- vs forecast for the day.

ALTER TABLE daily_summaries
  -- EV charging totals + source split for the day.
  ADD COLUMN IF NOT EXISTS ev_charged_kwh REAL,
  ADD COLUMN IF NOT EXISTS ev_solar_kwh REAL,
  ADD COLUMN IF NOT EXISTS ev_pw_kwh REAL,
  ADD COLUMN IF NOT EXISTS ev_grid_kwh REAL,
  -- Powerwall flow attribution. "Charged from" = pw_w < 0 ticks,
  -- split between solar surplus and grid import. "Discharged to"
  -- = pw_w > 0 ticks, split between home load and EV draw.
  ADD COLUMN IF NOT EXISTS pw_charged_from_solar_kwh REAL,
  ADD COLUMN IF NOT EXISTS pw_charged_from_grid_kwh REAL,
  ADD COLUMN IF NOT EXISTS pw_discharged_to_home_kwh REAL,
  ADD COLUMN IF NOT EXISTS pw_discharged_to_ev_kwh REAL,
  -- Peak instantaneous values in the day. Useful for "how hard
  -- did the system work today?" trend cards.
  ADD COLUMN IF NOT EXISTS peak_solar_kw REAL,
  ADD COLUMN IF NOT EXISTS peak_home_kw REAL,
  ADD COLUMN IF NOT EXISTS peak_ev_kw REAL,
  -- # of full hours the day spent with grid_w == 0 (pure
  -- self-sufficiency window). Goes alongside the existing
  -- self_sufficiency percentage which is energy-weighted.
  ADD COLUMN IF NOT EXISTS hours_self_sufficient INT,
  -- Forecast vs actual. forecast_kwh is the morning-of capture;
  -- actual_kwh is the same as produced_kwh, denormalized for
  -- convenience; forecast_error_pct = (actual - forecast) / forecast.
  ADD COLUMN IF NOT EXISTS forecast_kwh REAL,
  ADD COLUMN IF NOT EXISTS actual_kwh REAL,
  ADD COLUMN IF NOT EXISTS forecast_error_pct REAL;

-- Already keyed on date, no new index needed.
