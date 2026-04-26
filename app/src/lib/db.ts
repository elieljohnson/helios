// Storage layer. When DATABASE_URL is set we talk to Postgres via Drizzle;
// otherwise we keep an in-memory log so dev + tests work without a DB.
// Every consumer (route handlers, cron) uses the async API below — the
// swap happens behind this boundary.

import { desc, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { controlActions, energySnapshots, oauthTokens, userConfig, type OAuthProvider } from "@/db/schema";
import { DEFAULT_CONFIG } from "./config";
import type { ActionEntry, ActionType, ConfigResponse, EnergySnapshot } from "./types";

type AppendAction = {
  type: ActionType;
  title: string;
  reason: string;
  ok: boolean;
  /** Target value the action set (e.g. reserve %, desired charge kW). */
  targetValue?: number | null;
  /** Pre-action value, for delta display in the activity log. */
  prevValue?: number | null;
};

// Lazy Drizzle client — only constructed once, only when DATABASE_URL
// is set. Keeping this module-scoped means hot-reload reuses the pool.
let _db: PostgresJsDatabase | null = null;

export function getDb(): PostgresJsDatabase | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (_db) return _db;
  const client = postgres(url, { max: 3, prepare: false });
  _db = drizzle(client);
  return _db;
}

// In-memory fallback. Scoped to the module; in dev HMR clears it.
const memoryLog: ActionEntry[] = [];
const memorySnapshots: { captured_at: string; snapshot: EnergySnapshot }[] = [];
let memoryConfig: ConfigResponse = { ...DEFAULT_CONFIG };
const memoryTokens = new Map<OAuthProvider, OAuthTokenRecord>();

function toEntry(row: typeof controlActions.$inferSelect): ActionEntry {
  return {
    timestamp: row.occurredAt.toISOString(),
    display_time: row.occurredAt.toTimeString().slice(0, 5),
    type: row.type as ActionType,
    title: row.title,
    reason: row.reason,
    ok: row.ok,
    target_value: row.targetValue,
    prev_value: row.prevValue,
  };
}

export async function appendAction(entry: AppendAction): Promise<ActionEntry> {
  const now = new Date();
  const record: ActionEntry = {
    timestamp: now.toISOString(),
    display_time: now.toTimeString().slice(0, 5),
    type: entry.type,
    title: entry.title,
    reason: entry.reason,
    ok: entry.ok,
    target_value: entry.targetValue ?? null,
    prev_value: entry.prevValue ?? null,
  };

  const db = getDb();
  if (db) {
    const [row] = await db
      .insert(controlActions)
      .values({
        occurredAt: now,
        type: entry.type,
        title: entry.title,
        reason: entry.reason,
        ok: entry.ok,
        targetValue: entry.targetValue ?? null,
        prevValue: entry.prevValue ?? null,
      })
      .returning();
    return toEntry(row);
  }

  memoryLog.unshift(record);
  if (memoryLog.length > 100) memoryLog.length = 100;
  return record;
}

export async function listActions(limit = 50): Promise<ActionEntry[]> {
  const db = getDb();
  if (db) {
    const rows = await db
      .select()
      .from(controlActions)
      .orderBy(desc(controlActions.occurredAt))
      .limit(limit);
    return rows.map(toEntry);
  }
  return memoryLog.slice(0, limit);
}

export async function secondsSinceLastAction(): Promise<number> {
  const [last] = await listActions(1);
  if (!last) return Infinity;
  return (Date.now() - new Date(last.timestamp).getTime()) / 1000;
}

// Writes a snapshot at cron tick time. Returns the captured_at it used.
export async function writeSnapshot(s: EnergySnapshot): Promise<string> {
  const captured_at = new Date();
  const db = getDb();
  if (db) {
    await db.insert(energySnapshots).values({
      capturedAt: captured_at,
      solarW: s.solar_w,
      homeW: s.home_w,
      evW: s.ev_w,
      pwW: s.pw_w,
      gridW: s.grid_w,
      pwSoc: s.pw_soc,
      pwReserve: s.pw_reserve,
      evSoc: s.ev_soc,
      evCharging: s.ev_charging,
      touPeriod: s.tou_period,
      touRate: s.tou_rate,
      selfSufficiency: s.self_sufficiency,
    });
    return captured_at.toISOString();
  }
  memorySnapshots.unshift({ captured_at: captured_at.toISOString(), snapshot: s });
  if (memorySnapshots.length > 1000) memorySnapshots.length = 1000;
  return captured_at.toISOString();
}

// --- Config ---------------------------------------------------------
// Single-row table (id=1, see migration 0001). Fields map between
// snake_case API/types and camelCase Drizzle columns. Memory fallback
// mirrors DEFAULT_CONFIG so Settings UI works without a DB.

type UserConfigRow = typeof userConfig.$inferSelect;

function rowToConfig(row: UserConfigRow): ConfigResponse {
  return {
    ev_charge_threshold_kw: row.evChargeThresholdKw,
    ev_charge_hysteresis_kw: row.evChargeHysteresisKw,
    reserve_floor_pct: row.reserveFloorPct,
    reserve_peak_pct: row.reservePeakPct,
    reserve_storm_pct: row.reserveStormPct,
    storm_forecast_kwh: row.stormForecastKwh,
    min_action_interval_sec: row.minActionIntervalSec,
    pw_sunset_target_pct: row.pwSunsetTargetPct,
    ev_min_pct: row.evMinPct,
    sunset_buffer_hours: row.sunsetBufferHours,
    parked_schedule: row.parkedSchedule,
    backstop_enabled: row.backstopEnabled,
    backstop_disabled_until: row.backstopDisabledUntil,
  };
}

function configToUpdate(p: Partial<ConfigResponse>): Partial<typeof userConfig.$inferInsert> {
  const u: Partial<typeof userConfig.$inferInsert> = {};
  if (p.ev_charge_threshold_kw !== undefined) u.evChargeThresholdKw = p.ev_charge_threshold_kw;
  if (p.ev_charge_hysteresis_kw !== undefined) u.evChargeHysteresisKw = p.ev_charge_hysteresis_kw;
  if (p.reserve_floor_pct !== undefined) u.reserveFloorPct = p.reserve_floor_pct;
  if (p.reserve_peak_pct !== undefined) u.reservePeakPct = p.reserve_peak_pct;
  if (p.reserve_storm_pct !== undefined) u.reserveStormPct = p.reserve_storm_pct;
  if (p.storm_forecast_kwh !== undefined) u.stormForecastKwh = p.storm_forecast_kwh;
  if (p.min_action_interval_sec !== undefined) u.minActionIntervalSec = p.min_action_interval_sec;
  if (p.pw_sunset_target_pct !== undefined) u.pwSunsetTargetPct = p.pw_sunset_target_pct;
  if (p.ev_min_pct !== undefined) u.evMinPct = p.ev_min_pct;
  if (p.sunset_buffer_hours !== undefined) u.sunsetBufferHours = p.sunset_buffer_hours;
  if (p.parked_schedule !== undefined) u.parkedSchedule = p.parked_schedule;
  if (p.backstop_enabled !== undefined) u.backstopEnabled = p.backstop_enabled;
  if (p.backstop_disabled_until !== undefined) u.backstopDisabledUntil = p.backstop_disabled_until;
  return u;
}

export async function getConfig(): Promise<ConfigResponse> {
  const db = getDb();
  if (db) {
    const [row] = await db
      .select()
      .from(userConfig)
      .where(eq(userConfig.id, 1))
      .limit(1);
    if (row) return rowToConfig(row);
    // Singleton row missing — seed it. Migration 0001 already does this
    // on fresh installs; this branch covers a rare blank-DB case.
    await db.insert(userConfig).values({ id: 1 }).onConflictDoNothing();
    return { ...DEFAULT_CONFIG };
  }
  return { ...memoryConfig };
}

export async function setConfig(partial: Partial<ConfigResponse>): Promise<ConfigResponse> {
  const db = getDb();
  if (db) {
    const update = configToUpdate(partial);
    update.updatedAt = new Date();
    await db.update(userConfig).set(update).where(eq(userConfig.id, 1));
    return getConfig();
  }
  memoryConfig = { ...memoryConfig, ...partial };
  return { ...memoryConfig };
}

// --- OAuth tokens ---------------------------------------------------
// Provider-keyed token storage. The Enphase/Smartcar adapters call
// getToken(provider) on every request and refreshToken(...) when
// expires_at < now. Memory fallback keeps dev workflows untethered
// from the DB.

export type OAuthTokenRecord = {
  provider: OAuthProvider;
  access_token: string;
  refresh_token: string;
  /** ISO 8601 timestamp. */
  expires_at: string;
  system_id: string | null;
  meta: Record<string, unknown> | null;
};

export async function getToken(
  provider: OAuthProvider,
): Promise<OAuthTokenRecord | null> {
  const db = getDb();
  if (db) {
    const [row] = await db
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.provider, provider))
      .limit(1);
    if (!row) return null;
    return {
      provider: row.provider,
      access_token: row.accessToken,
      refresh_token: row.refreshToken,
      expires_at: row.expiresAt.toISOString(),
      system_id: row.systemId,
      meta: row.meta,
    };
  }
  return memoryTokens.get(provider) ?? null;
}

export async function saveToken(record: OAuthTokenRecord): Promise<void> {
  const db = getDb();
  if (db) {
    await db
      .insert(oauthTokens)
      .values({
        provider: record.provider,
        accessToken: record.access_token,
        refreshToken: record.refresh_token,
        expiresAt: new Date(record.expires_at),
        systemId: record.system_id,
        meta: record.meta ?? undefined,
      })
      .onConflictDoUpdate({
        target: oauthTokens.provider,
        set: {
          accessToken: record.access_token,
          refreshToken: record.refresh_token,
          expiresAt: new Date(record.expires_at),
          systemId: record.system_id,
          meta: record.meta ?? undefined,
          updatedAt: new Date(),
        },
      });
    return;
  }
  memoryTokens.set(record.provider, record);
}

export async function deleteToken(provider: OAuthProvider): Promise<void> {
  const db = getDb();
  if (db) {
    await db.delete(oauthTokens).where(eq(oauthTokens.provider, provider));
    return;
  }
  memoryTokens.delete(provider);
}
