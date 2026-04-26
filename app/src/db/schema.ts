// Drizzle schema. Mirrors db/migrations/0001_init.sql — the SQL file is
// the source of truth for migrations; this file is the typed accessor.
// Keep the two in sync when evolving the schema.

import { bigint, bigserial, boolean, date, integer, jsonb, pgTable, real, text, timestamp } from "drizzle-orm/pg-core";

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

  // Sunset-aware EV charging policy (migration 0002).
  pwSunsetTargetPct: real("pw_sunset_target_pct").notNull().default(80),
  evMinPct: real("ev_min_pct").notNull().default(30),
  sunsetBufferHours: real("sunset_buffer_hours").notNull().default(1),
  parkedSchedule: boolean("parked_schedule")
    .array()
    .notNull()
    .default([true, true, false, false, false, true, true]),
  backstopEnabled: boolean("backstop_enabled").notNull().default(true),
  backstopDisabledUntil: date("backstop_disabled_until"),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Provider OAuth tokens. One row per provider in the single-tenant MVP.
// See db/migrations/0003_oauth_tokens.sql.
export type OAuthProvider = "enphase" | "smartcar" | "tesla";

export const oauthTokens = pgTable("oauth_tokens", {
  provider: text("provider").primaryKey().$type<OAuthProvider>(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  systemId: text("system_id"),
  meta: jsonb("meta").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Latest charger telemetry. Singleton row (id = 1) upserted by the home
// poller via /api/ingest/wall-connector. See db/migrations/0004.
export const wallConnectorState = pgTable("wall_connector_state", {
  id: integer("id").primaryKey().default(1),
  vehicleConnected: boolean("vehicle_connected").notNull(),
  isCharging: boolean("is_charging").notNull(),
  powerW: integer("power_w").notNull(),
  sessionEnergyWh: integer("session_energy_wh").notNull().default(0),
  sessionSeconds: integer("session_seconds").notNull().default(0),
  lifetimeEnergyWh: bigint("lifetime_energy_wh", { mode: "number" }),
  voltageV: real("voltage_v"),
  currentA: real("current_a"),
  evseState: integer("evse_state"),
  raw: jsonb("raw").$type<Record<string, unknown>>(),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
