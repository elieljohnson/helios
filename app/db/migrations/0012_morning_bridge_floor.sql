-- 0012_morning_bridge_floor.sql
--
-- Morning-bridge floor for Powerwall reserve. The standard
-- reserve_floor_pct (20%) protects overnight headroom and prevents
-- excessive cycling. But on a sunny morning when the sun is about to
-- take over, holding firm at 20% means the house imports a small
-- amount from the grid for 30-90 min until solar exceeds home demand.
-- The morning-bridge rule lowers the reserve target temporarily
-- (during off-peak + sun-is-up + sunny-day-ahead) so the Powerwall
-- can cover that bridge instead of importing.
--
-- 10% default leaves Tesla's hardware-protected minimum intact and
-- keeps a small emergency cushion. Users who want more aggressive
-- bridging can drop to 5% via Settings; users who want NO bridging
-- can set this equal to reserve_floor_pct.

ALTER TABLE user_config
  ADD COLUMN IF NOT EXISTS morning_bridge_floor_pct REAL NOT NULL DEFAULT 10;
