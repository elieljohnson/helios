-- 0011_nem_export_rate.sql
--
-- NEM 3.0 export-credit accounting. The CostCard previously showed only
-- gross imports; this enables net cost = imports − exports × export_rate.
--
-- Default $0.04/kWh is a flat-rate approximation of PG&E's NBT (Net
-- Billing Tariff) Avoided Cost Calculator, which actually varies hour-
-- by-hour and seasonally. The flat rate is good enough to surface the
-- "earning vs spending" signal in the dashboard; refining to hourly
-- ACC values is a future task that doesn't change this column shape.
--
-- Stored as REAL (cents-per-kWh would be cleaner integer math but this
-- keeps the units consistent with the rest of the rate columns).

ALTER TABLE user_config
  ADD COLUMN IF NOT EXISTS nem_export_rate_per_kwh REAL NOT NULL DEFAULT 0.04;
