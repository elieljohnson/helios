-- Adds sunset-aware EV charging policy fields. Drives decideEvCharge():
--   pw_sunset_target_pct      — PW SoC target at sunset−buffer (Mill Valley: 80%)
--   ev_min_pct                — EV SoC floor that triggers off-peak backstop
--   sunset_buffer_hours       — hours before sunset to lock the cutoff
--   parked_schedule           — [Sun,Mon,Tue,Wed,Thu,Fri,Sat] availability
--   backstop_enabled          — master toggle for off-peak grid backstop
--   backstop_disabled_until   — single-day skip override (YYYY-MM-DD)
--
-- All non-null with sane defaults so existing user_config rows survive.

ALTER TABLE user_config
  ADD COLUMN IF NOT EXISTS pw_sunset_target_pct REAL NOT NULL DEFAULT 80,
  ADD COLUMN IF NOT EXISTS ev_min_pct REAL NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS sunset_buffer_hours REAL NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS parked_schedule BOOLEAN[] NOT NULL
    DEFAULT '{true,true,false,false,false,true,true}',
  ADD COLUMN IF NOT EXISTS backstop_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS backstop_disabled_until DATE;
