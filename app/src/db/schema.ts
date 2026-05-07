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
  // Structured projection metadata (migration 0014). Populated by
  // the EV decision engine on charge-type rows; null elsewhere.
  zone: text("zone").$type<"comfort" | "caution" | "defend" | null>(),
  evChargeLimitPct: real("ev_charge_limit_pct"),
  projectedEndPwPct: real("projected_end_pw_pct"),
  projectedDeparturePwPct: real("projected_departure_pw_pct"),
  mode: text("mode").$type<"parked" | "driving" | null>(),
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
  // Enrichment columns (migration 0017). Nullable — populated by the
  // nightly rollup writer going forward; pre-existing rows stay valid.
  evChargedKwh: real("ev_charged_kwh"),
  evSolarKwh: real("ev_solar_kwh"),
  evPwKwh: real("ev_pw_kwh"),
  evGridKwh: real("ev_grid_kwh"),
  pwChargedFromSolarKwh: real("pw_charged_from_solar_kwh"),
  pwChargedFromGridKwh: real("pw_charged_from_grid_kwh"),
  pwDischargedToHomeKwh: real("pw_discharged_to_home_kwh"),
  pwDischargedToEvKwh: real("pw_discharged_to_ev_kwh"),
  peakSolarKw: real("peak_solar_kw"),
  peakHomeKw: real("peak_home_kw"),
  peakEvKw: real("peak_ev_kw"),
  hoursSelfSufficient: integer("hours_self_sufficient"),
  forecastKwh: real("forecast_kwh"),
  actualKwh: real("actual_kwh"),
  forecastErrorPct: real("forecast_error_pct"),
  // Overnight PW endpoints (migration 0018). Together with
  // yesterday's evening_high_pw_pct, today's morning_low_pw_pct
  // gives the overnight drain pattern. Captured for future learned-
  // overnight-target work; the static pw_sunset_target_pct config
  // continues to drive engine decisions today.
  morningLowPwPct: real("morning_low_pw_pct"),
  morningLowAtHourPt: integer("morning_low_at_hour_pt"),
  eveningHighPwPct: real("evening_high_pw_pct"),
  eveningHighAtHourPt: integer("evening_high_at_hour_pt"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// EV charge sessions (migration 0015). One row per discrete charging
// session. Built by detectEvSession() in the cron route on each tick:
// flips false→true → row opened; flips true→false → row closed and
// finalized with totals.
export const evChargeSessions = pgTable("ev_charge_sessions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  durationMin: real("duration_min"),
  startSocPct: real("start_soc_pct").notNull(),
  endSocPct: real("end_soc_pct"),
  kwhDelivered: real("kwh_delivered").notNull().default(0),
  solarKwh: real("solar_kwh").notNull().default(0),
  pwKwh: real("pw_kwh").notNull().default(0),
  gridKwh: real("grid_kwh").notNull().default(0),
  peakRateKw: real("peak_rate_kw").notNull().default(0),
  avgRateKw: real("avg_rate_kw").notNull().default(0),
  costUsd: real("cost_usd").notNull().default(0),
  dayKind: text("day_kind").$type<"parked" | "driving" | null>(),
  authorizingActionId: bigint("authorizing_action_id", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Forecast snapshots (migration 0016). Captured at the first cron
// tick of each PT day plus on revisions where daily_kwh diff ≥ 5 kWh.
export const forecastSnapshots = pgTable("forecast_snapshots", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  forecastForDate: date("forecast_for_date").notNull(),
  dailyKwh: real("daily_kwh").notNull(),
  dailyHighF: real("daily_high_f"),
  dailyLowF: real("daily_low_f"),
  dailyCloudPct: real("daily_cloud_pct"),
  hourlySolarKw: jsonb("hourly_solar_kw").$type<number[]>().notNull(),
  sunriseAt: timestamp("sunrise_at", { withTimezone: true }),
  sunsetAt: timestamp("sunset_at", { withTimezone: true }),
  revisionNumber: integer("revision_number").notNull().default(0),
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

  // Master pause switch (migration 0007). When false, the cron route
  // skips all actuator calls (PW reserve, Rivian start/stop) but still
  // writes snapshots so history is uninterrupted.
  automationEnabled: boolean("automation_enabled").notNull().default(true),

  // EV solar-boost cap (migrations 0008, 0009). Engine stops EV at
  // min(snapshot.ev_target, this value). Default 100 means "respect
  // the Rivian's own charge limit"; user lowers it only to enforce a
  // stricter Helios-side ceiling.
  evSolarBoostCapPct: real("ev_solar_boost_cap_pct").notNull().default(100),

  // Pre-departure charge knobs (migration 0010). On non-parked days
  // when the car is still plugged in, the engine pre-charges the EV
  // iff today's forecast ≥ surplusForecastKwh AND pw_soc ≥
  // morningPwFloorPct. Either false → existing "not a parked day"
  // hard-stop applies.
  surplusForecastKwh: real("surplus_forecast_kwh").notNull().default(40),
  morningPwFloorPct: real("morning_pw_floor_pct").notNull().default(20),

  // PG&E NBT (NEM 3.0) export-credit rate in $/kWh. Year-round flat
  // approximation — refining to hourly ACC values is a separate task.
  nemExportRatePerKwh: real("nem_export_rate_per_kwh").notNull().default(0.04),

  // Morning-bridge floor for the PW reserve. When sun is up, today's
  // forecast is sunny, and solar < home (still in deficit), the
  // engine lowers the reserve target to this value so the Powerwall
  // can cover the bridge instead of importing from grid. See
  // decide.ts morning-bridge branch.
  morningBridgeFloorPct: real("morning_bridge_floor_pct").notNull().default(10),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Provider OAuth tokens. One row per provider in the single-tenant MVP.
// See db/migrations/0003_oauth_tokens.sql + 0005_rivian_provider.sql.
export type OAuthProvider = "enphase" | "smartcar" | "tesla" | "rivian";

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

// Web Push subscriptions. One row per (browser, device); the
// pushManager.subscribe() endpoint is unique per device and serves as
// the primary key. See db/migrations/0013_push_subscriptions.sql and
// lib/push.ts for the send-side wiring.
export const pushSubscriptions = pgTable("push_subscriptions", {
  endpoint: text("endpoint").primaryKey(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
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
