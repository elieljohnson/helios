-- Repair historical energy_snapshots.ev_w values corrupted by the
-- Tesla wall-connector unit bug (commit 129ee62, fixed 2026-04-26 17:05 PT).
--
-- The bug: status.ts multiplied wall_connector_power by 1000 on the
-- assumption it was kilowatts, but Tesla Fleet API reports it in
-- watts (same as solar_power, load_power, battery_power, grid_power).
-- Pre-fix: a 6.18 kW charging session got persisted as ev_w =
-- 6,180,443. Post-fix snapshots store the correct watts directly.
--
-- The bad rows poison every rollup that integrates ev_w over time:
--   - getEvChargedTodayKwh   → 4900+ kWh "today" for a 135 kWh battery
--   - getEvSourceTodaySplit  → percentages still right (ratio invariant)
--                              but underlying total is huge
--
-- Threshold: 25,000 W is comfortably above any residential L2 charger
-- (Tesla WC max = 11.5 kW; Wall Connector Gen 3 max = 19.2 kW). Any
-- ev_w > 25 kW is the bug, full stop. Divide by 1000 to recover the
-- real value.
--
-- Idempotent: running twice is safe — the second pass finds no rows
-- > 25 kW (the first pass corrected them all). The accompanying
-- read-side sanitizeEvW() in lib/db.ts gives the same protection
-- before this migration runs, so the dashboard reads correctly even
-- without the migration applied. Migration just makes the data clean
-- on disk.

UPDATE energy_snapshots
SET ev_w = ev_w / 1000
WHERE ev_w > 25000;
