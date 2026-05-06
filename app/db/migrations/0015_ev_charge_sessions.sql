-- Migration 0015. EV charging sessions, one row per discrete
-- charging session (ev_charging flips false→true → row opened;
-- flips true→false → row closed). Built by detectEvSession() in
-- the cron route on each tick.
--
-- Source split (solar_kwh / pw_kwh / grid_kwh) is the per-tick
-- proportional attribution accumulated across the session: at each
-- tick where the EV is drawing, the draw is split between solar
-- surplus (solar minus house excluding EV), PW discharge, and grid
-- import in that priority order.

CREATE TABLE IF NOT EXISTS ev_charge_sessions (
  id                BIGSERIAL PRIMARY KEY,
  started_at        TIMESTAMPTZ NOT NULL,
  -- NULL while the session is open (current charging in progress);
  -- written when ev_charging flips back to false.
  ended_at          TIMESTAMPTZ,
  duration_min      REAL,
  -- EV state-of-charge at session boundaries (% of capacity).
  start_soc_pct     REAL NOT NULL,
  end_soc_pct       REAL,
  -- Total kWh delivered to the EV during the session. Sum of
  -- (ev_w * tick_interval) across all ticks where ev_charging was
  -- true within [started_at, ended_at].
  kwh_delivered     REAL NOT NULL DEFAULT 0,
  -- Source attribution accumulated tick-by-tick.
  --   solar_kwh + pw_kwh + grid_kwh ≈ kwh_delivered (modulo rounding
  --   and edge ticks where ev_w briefly disagrees with attribution).
  solar_kwh         REAL NOT NULL DEFAULT 0,
  pw_kwh            REAL NOT NULL DEFAULT 0,
  grid_kwh          REAL NOT NULL DEFAULT 0,
  -- Peak and average draw during the session, for "how hard did the
  -- car pull?" analysis.
  peak_rate_kw      REAL NOT NULL DEFAULT 0,
  avg_rate_kw       REAL NOT NULL DEFAULT 0,
  -- Grid portion's cost: integrate (grid_share_kw * tou_rate * dt).
  cost_usd          REAL NOT NULL DEFAULT 0,
  -- Day classification at session start. Useful for "are driving-day
  -- charges meaningfully different from parked-day charges?"
  day_kind          TEXT
    CHECK (day_kind IS NULL OR day_kind IN ('parked', 'driving')),
  -- The control_actions row that authorized the start, if any.
  -- Lets us trace "what reasoning did the engine use to start this?"
  authorizing_action_id BIGINT REFERENCES control_actions (id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Most reads are "recent sessions, newest first." Index on started_at.
CREATE INDEX IF NOT EXISTS idx_ev_sessions_started_at
  ON ev_charge_sessions (started_at DESC);

-- The detector uses "is there an open session right now?" — a
-- partial index on the rare open-session row for fast lookup.
CREATE INDEX IF NOT EXISTS idx_ev_sessions_open
  ON ev_charge_sessions (id)
  WHERE ended_at IS NULL;
