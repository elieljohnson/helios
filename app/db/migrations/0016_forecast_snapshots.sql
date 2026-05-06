-- Migration 0016. Forecast snapshots, captured at the first cron
-- tick of each PT day plus on meaningful Open-Meteo revisions
-- (daily_kwh changed by ≥ 5 kWh from the previous capture).
--
-- This is what enables actual-vs-forecast trend analysis: at the
-- end of any day we can compare what was predicted in the morning
-- against what actually showed up.

CREATE TABLE IF NOT EXISTS forecast_snapshots (
  id                  BIGSERIAL PRIMARY KEY,
  -- When we captured this forecast snapshot.
  captured_at         TIMESTAMPTZ NOT NULL,
  -- The PT date the forecast is FOR (not the date we captured on).
  -- Multiple captures per forecast_for_date are expected (one
  -- morning + revisions throughout the day).
  forecast_for_date   DATE NOT NULL,
  -- Daily aggregate from Open-Meteo.
  daily_kwh           REAL NOT NULL,
  daily_high_f        REAL,
  daily_low_f         REAL,
  daily_cloud_pct     REAL,
  -- 24-element array of hourly solar forecast (kW per hour 0..23).
  -- JSONB rather than a separate table — we always read the whole
  -- curve at once, never query individual hours. Stored compactly.
  hourly_solar_kw     JSONB NOT NULL,
  -- Sun events for the date. Optional — only present when Open-
  -- Meteo gave us solar-time data.
  sunrise_at          TIMESTAMPTZ,
  sunset_at           TIMESTAMPTZ,
  -- Revision counter within forecast_for_date. 0 = first capture
  -- (morning), incremented for each subsequent revision that
  -- crossed the 5-kWh delta threshold.
  revision_number     INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Most queries are "get the latest forecast for this day" or "all
-- forecasts for a date range."
CREATE INDEX IF NOT EXISTS idx_forecast_for_date
  ON forecast_snapshots (forecast_for_date DESC, revision_number DESC);

CREATE INDEX IF NOT EXISTS idx_forecast_captured_at
  ON forecast_snapshots (captured_at DESC);
