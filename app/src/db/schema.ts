// Drizzle schema. Mirrors db/migrations/0001_init.sql — the SQL file is
// the source of truth for migrations; this file is the typed accessor.
// Keep the two in sync when evolving the schema.

import { bigserial, boolean, date, integer, pgTable, real, text, timestamp } from "drizzle-orm/pg-core";

export const energySnapshots = pgTable("energy_snapshots", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  solarW: integer("solar_w").notNull(),
  homeW: integer("home_w").notNull(),
  evW: integer("ev_w").notNull(),
  pwW: integer("pw_w").notNull(),
  gridW: integer("grid_w").notNull(),
  pwSoc: real("pw_soc").notNull(),
  pwReserve: real("pw_reserve").notNull(),
  evSoc: real("ev_soc"),
  evCharging: boolean("ev_charging").notNull().default(false),
  touPeriod: text("tou_period").notNull(),
  touRate: real("tou_rate").notNull(),
  selfSufficiency: real("self_sufficiency"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const controlActions = pgTable("control_actions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  reason: text("reason").notNull(),
  ok: boolean("ok").notNull(),
  targetValue: real("target_value"),
  prevValue: real("prev_value"),
  snapshotId: integer("snapshot_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const dailySummaries = pgTable("daily_summaries", {
  date: date("date").primaryKey(),
  producedKwh: real("produced_kwh").notNull(),
  consumedKwh: real("consumed_kwh").notNull(),
  gridImportKwh: real("grid_import_kwh").notNull(),
  gridExportKwh: real("grid_export_kwh").notNull(),
  selfSufficiency: real("self_sufficiency").notNull(),
  dailyCost: real("daily_cost").notNull(),
  dailySavings: real("daily_savings").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userConfig = pgTable("user_config", {
  id: integer("id").primaryKey().default(1),
  evChargeThresholdKw: real("ev_charge_threshold_kw").notNull().default(2.0),
  evChargeHysteresisKw: real("ev_charge_hysteresis_kw").notNull().default(0.5),
  reserveFloorPct: real("reserve_floor_pct").notNull().default(20),
  reservePeakPct: real("reserve_peak_pct").notNull().default(60),
  reserveStormPct: real("reserve_storm_pct").notNull().default(80),
  stormForecastKwh: real("storm_forecast_kwh").notNull().default(15),
  minActionIntervalSec: integer("min_action_interval_sec").notNull().default(300),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
