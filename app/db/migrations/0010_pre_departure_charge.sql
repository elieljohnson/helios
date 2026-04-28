-- Pre-departure morning charge: relax the "not a parked day" hard-stop
-- so the car can absorb early-morning solar while it's still plugged
-- in and the day's forecast says PW will easily fill anyway.
--
-- Why: on non-parked days the car leaves mid-morning. Solar that hits
-- after the cable disconnects either fills PW (until 100%) or exports
-- to grid at the brutal NEM 3.0 rate (~$0.04/kWh). On high-forecast
-- days that's wasted energy — the PW will fill from solar regardless.
-- Better to capture early-morning surplus in the EV battery for a
-- future drive.
--
-- Two new knobs gate the relaxation. Both must be true to pre-charge:
--
--   surplus_forecast_kwh:    today's daily forecast must exceed this
--                            (default 40, paired with storm_forecast_kwh=15
--                            on the low side — leaves a 15..40 kWh
--                            "neutral" band where neither rule fires).
--   morning_pw_floor_pct:    PW SoC must be at or above this (default 20,
--                            matches the existing reserve floor — refusing
--                            to dip into reserve for EV when solar is
--                            low enough that PW recovery is uncertain).
--
-- Either condition false → existing hard-stop applies (engine stays in
-- "Today is not a parked day" mode).

ALTER TABLE user_config
  ADD COLUMN IF NOT EXISTS surplus_forecast_kwh REAL NOT NULL DEFAULT 40;

ALTER TABLE user_config
  ADD COLUMN IF NOT EXISTS morning_pw_floor_pct REAL NOT NULL DEFAULT 20;
