-- Helios initial schema. Designed for Vercel Postgres (pgvector not needed).
-- Each table maps to a concern in the PRD §2.3 backend:
--   energy_snapshots  — every READ pass of the decision loop
--   control_actions   — every ACT pass (reserve writes, charge start/stop)
--   daily_summaries   — nightly rollup for the Activity screen's totals
--   user_config       — tunable thresholds (one row per user; single-user MVP)

CREATE TABLE IF NOT EXISTS energy_snapshots (
  id                BIGSERIAL PRIMARY KEY,
  captured_at       TIMESTAMPTZ NOT NULL,
  solar_w           INT NOT NULL,
  home_w            INT NOT NULL,
  ev_w              INT NOT NULL,
  pw_w              INT NOT NULL,
  grid_w            INT NOT NULL,
  pw_soc            REAL NOT NULL,
  pw_reserve        REAL NOT NULL,
  ev_soc            REAL,
  ev_charging       BOOLEAN NOT NULL DEFAULT FALSE,
  tou_period        TEXT NOT NULL CHECK (tou_period IN ('off-peak','mid-peak','peak')),
  tou_rate          REAL NOT NULL,
  self_sufficiency  REAL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_captured_at
  ON energy_snapshots (captured_at DESC);

CREATE TABLE IF NOT EXISTS control_actions (
  id            BIGSERIAL PRIMARY KEY,
  occurred_at   TIMESTAMPTZ NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('reserve','charge','forecast','info','alert')),
  title         TEXT NOT NULL,
  reason        TEXT NOT NULL,
  ok            BOOLEAN NOT NULL,
  target_value  REAL,
  prev_value    REAL,
  snapshot_id   BIGINT REFERENCES energy_snapshots (id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_actions_occurred_at
  ON control_actions (occurred_at DESC);

CREATE TABLE IF NOT EXISTS daily_summaries (
  date              DATE PRIMARY KEY,
  produced_kwh      REAL NOT NULL,
  consumed_kwh      REAL NOT NULL,
  grid_import_kwh   REAL NOT NULL,
  grid_export_kwh   REAL NOT NULL,
  self_sufficiency  REAL NOT NULL,
  daily_cost        REAL NOT NULL,
  daily_savings     REAL NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_config (
  id                        INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ev_charge_threshold_kw    REAL NOT NULL DEFAULT 2.0,
  ev_charge_hysteresis_kw   REAL NOT NULL DEFAULT 0.5,
  reserve_floor_pct         REAL NOT NULL DEFAULT 20,
  reserve_peak_pct          REAL NOT NULL DEFAULT 60,
  reserve_storm_pct         REAL NOT NULL DEFAULT 80,
  storm_forecast_kwh        REAL NOT NULL DEFAULT 15,
  min_action_interval_sec   INT NOT NULL DEFAULT 300,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed a single default config row. Subsequent ALTERs happen via UPSERT.
INSERT INTO user_config (id) VALUES (1) ON CONFLICT DO NOTHING;
