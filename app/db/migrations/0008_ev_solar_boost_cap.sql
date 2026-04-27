-- Add an "ev_solar_boost_cap_pct" column to user_config — the SoC at
-- which Helios stops sending solar to the EV and lets the rest export
-- to grid.
--
-- Use case: on a sunny day with PW already at its sunset target, surplus
-- solar should keep flowing to the car instead of straight to the grid
-- (NEM 3.0 export credits are ~$0.04/kWh — way worse than absorbing the
-- energy into the EV battery for a future drive). Default 85% sits one
-- bucket above the user's normal Rivian charge limit (80% for battery
-- longevity), buying ~5% extra range on free solar before the rest goes
-- back to the grid.
--
-- The cap is enforced engine-side: when ev_soc ≥ ev_solar_boost_cap_pct
-- the engine returns "stop" and Rivian schedules are cleared. Note this
-- is only effective if the Rivian's own charge limit (set in the Rivian
-- app) is ≥ the cap value — otherwise the car stops first on its own.
--
-- Default 85 so existing installations get the new behavior on the next
-- tick without any settings change.

ALTER TABLE user_config
  ADD COLUMN IF NOT EXISTS ev_solar_boost_cap_pct REAL NOT NULL DEFAULT 85;
