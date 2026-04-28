// Storage layer. When DATABASE_URL is set we talk to Postgres via Drizzle;
// otherwise we keep an in-memory log so dev + tests work without a DB.
// Every consumer (route handlers, cron) uses the async API below — the
// swap happens behind this boundary.

import { desc, eq, gte, sql } from "drizzle-orm";
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

/** ISO 8601 timestamps stay UTC (canonical), but the human-facing
 *  HH:MM string in display_time has to be computed in the user's
 *  timezone — Vercel runs in UTC, so toTimeString() would emit UTC.
 *  Single-tenant Helios is hardcoded to America/Los_Angeles, same
 *  zone the decision engine uses for sunset/cutoff math.
 *  en-CA gets us "23:40" cleanly without en-US's "24:40" midnight
 *  edge case under hour12=false. */
const HELIOS_DISPLAY_TZ = "America/Los_Angeles";
function localDisplayTime(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: HELIOS_DISPLAY_TZ,
  }).format(d);
}

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
    display_time: localDisplayTime(row.occurredAt),
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
    display_time: localDisplayTime(now),
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

// --- Self-sufficiency integration ----------------------------------
//
// The hero number on the dashboard. Definition (residential standard):
//
//   self_sufficiency_today_pct =
//     (consumed energy that came from on-site sources) / (total consumed)
//   = 1 − grid_import_kWh / total_consumed_kWh
//
// On-site = solar + Powerwall discharge. By conservation we don't have
// to attribute kWh to specific sources — anything not imported from the
// grid is by definition on-site. So home_w (Tesla's load_power, which
// already includes the EV draw via the home meter) is the right
// numerator, and the GREATEST(grid_w, 0) sum is the imported piece.
//
// Integration is a Riemann sum across snapshots captured today (PT
// calendar boundary). The cron writes one row every 5 min; multiplying
// each row's W by 5/60 hours gives the energy slice it represents.
// Approximation, accurate to ~minute-level cron drift.

/** Returns the most recent PT (America/Los_Angeles) midnight expressed
 *  as an absolute UTC instant. Walks the two possible offsets (PST
 *  −08:00, PDT −07:00) and picks the one that renders as 00:00 in PT —
 *  robust across DST transitions without depending on a date library. */
function ptStartOfToday(now: Date): Date {
  const ptDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  for (const offsetH of [7, 8]) {
    const candidate = new Date(`${ptDate}T00:00:00-0${offsetH}:00`);
    const renderedHour = parseInt(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "2-digit",
        hour12: false,
      }).format(candidate),
      10,
    );
    if (renderedHour === 0) return candidate;
  }
  // Fallback for the (theoretically impossible) case where neither
  // offset yields PT 00:00. Default to PST.
  return new Date(`${ptDate}T00:00:00-08:00`);
}

export type SelfSufficiencyPeriod = "day" | "week" | "month" | "year";

export type SelfSufficiencyHistory = {
  period: SelfSufficiencyPeriod;
  /** Aggregate self-sufficiency over the whole window (0–100). */
  headline_pct: number;
  /** One bucket per logical sub-period. Day → 24 hours, Week → 7 days,
   *  Month → ≤31 days, Year → ≤12 months. Buckets with no captured
   *  data are omitted (no zero-bars cluttering the chart). */
  points: { label: string; value: number; home_kwh: number }[];
};

/** Time-series of self-sufficiency for the activity page chart.
 *
 *  Buckets and labels per period:
 *    day    → hour of day in PT, label "00".."23"
 *    week   → date in PT, label "MM-DD"
 *    month  → date in PT, label "MM-DD"
 *    year   → month in PT, label "YYYY-MM"
 *
 *  Headline is computed across the whole window (not the average of
 *  bucket values) so it weights by actual energy consumed — long high-
 *  consumption days don't get diluted by short low-consumption days.
 *
 *  Returns the legacy 87% headline + empty points when no DB is wired
 *  (local-dev / tests). */
export async function getSelfSufficiencyHistory(
  period: SelfSufficiencyPeriod,
): Promise<SelfSufficiencyHistory> {
  const db = getDb();
  if (!db) return { period, headline_pct: 87, points: [] };

  const TZ = "America/Los_Angeles";
  const now = new Date();
  let windowStart: Date;
  let bucketSql;
  let labelize: (raw: string | number) => string;

  switch (period) {
    case "day": {
      windowStart = ptStartOfToday(now);
      bucketSql = sql<number>`EXTRACT(hour FROM ${energySnapshots.capturedAt} AT TIME ZONE ${TZ})::int`;
      labelize = (raw) => String(raw).padStart(2, "0");
      break;
    }
    case "week": {
      windowStart = new Date(ptStartOfToday(now).getTime() - 6 * 24 * 3600 * 1000);
      bucketSql = sql<string>`TO_CHAR(${energySnapshots.capturedAt} AT TIME ZONE ${TZ}, 'MM-DD')`;
      labelize = (raw) => String(raw);
      break;
    }
    case "month": {
      windowStart = new Date(ptStartOfToday(now).getTime() - 29 * 24 * 3600 * 1000);
      bucketSql = sql<string>`TO_CHAR(${energySnapshots.capturedAt} AT TIME ZONE ${TZ}, 'MM-DD')`;
      labelize = (raw) => String(raw);
      break;
    }
    case "year": {
      // 12 calendar months back, anchored at the current month.
      const ptDateStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ,
        year: "numeric",
        month: "2-digit",
      }).format(now);
      const [y, m] = ptDateStr.split("-").map(Number);
      const startMonth = m - 11;
      const startY = startMonth <= 0 ? y - 1 : y;
      const startM = startMonth <= 0 ? startMonth + 12 : startMonth;
      windowStart = new Date(
        `${startY}-${String(startM).padStart(2, "0")}-01T00:00:00-08:00`,
      );
      bucketSql = sql<string>`TO_CHAR(${energySnapshots.capturedAt} AT TIME ZONE ${TZ}, 'YYYY-MM')`;
      labelize = (raw) => String(raw);
      break;
    }
  }

  // GROUP BY / ORDER BY by ordinal (column 1) instead of repeating the
  // bucket expression. Why: Drizzle renders ${energySnapshots.capturedAt}
  // unqualified (`"captured_at"`) in SELECT but qualified
  // (`"energy_snapshots"."captured_at"`) in GROUP BY / ORDER BY contexts.
  // Postgres requires textual identity for non-aggregate columns to
  // satisfy GROUP BY, so the qualified-vs-unqualified mismatch throws
  // "column must appear in the GROUP BY clause." Ordinal references
  // sidestep that entirely.
  const rows = await db
    .select({
      bucket: bucketSql,
      home_kwh: sql<number>`SUM(${energySnapshots.homeW} * 5.0 / 60.0 / 1000.0)`,
      grid_kwh: sql<number>`SUM(GREATEST(${energySnapshots.gridW}, 0) * 5.0 / 60.0 / 1000.0)`,
    })
    .from(energySnapshots)
    .where(gte(energySnapshots.capturedAt, windowStart))
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  const points = rows
    .filter((r) => Number(r.home_kwh) > 0)
    .map((r) => {
      const home = Number(r.home_kwh);
      const grid = Number(r.grid_kwh);
      const ssPct = Math.max(
        0,
        Math.min(100, Math.round(((home - grid) / home) * 100)),
      );
      return {
        label: labelize(r.bucket as string | number),
        value: ssPct,
        home_kwh: +home.toFixed(2),
      };
    });

  const totalHome = rows.reduce((s, r) => s + Number(r.home_kwh), 0);
  const totalGrid = rows.reduce((s, r) => s + Number(r.grid_kwh), 0);
  const headline_pct =
    totalHome > 0
      ? Math.max(
          0,
          Math.min(100, Math.round(((totalHome - totalGrid) / totalHome) * 100)),
        )
      : 100;

  return { period, headline_pct, points };
}

/** Today's EV source split — what fraction of the car's charging
 *  energy came from on-site (solar + Powerwall, treated together since
 *  PW is solar storage) vs grid imports.
 *
 *  Per 5-min snapshot:
 *    grid_kwh_to_ev    = min(ev_w, max(0, grid_w)) × 5/60 / 1000
 *    onsite_kwh_to_ev  = max(0, ev_w − max(0, grid_w)) × 5/60 / 1000
 *
 *  This conservatively attributes any net grid import that happened
 *  during EV charging to the car (assumption: if the car wasn't
 *  pulling, you wouldn't have hit the grid). When grid_w ≤ 0 (no
 *  import or actively exporting), all EV draw is on-site.
 *
 *  Returns mock {solar: 88, grid: 12} when no DB; {solar: 100, grid: 0}
 *  when no EV draw was logged today (defaults to flattering on-site-
 *  ness since "no charging happened" doesn't owe the grid anything).
 *  Always sums to 100. */
/** Ceiling for any plausible residential EV charging wattage. Tesla
 *  Universal WC max = 48 A × 240 V = 11.5 kW; Tesla Wall Connector
 *  Gen 3 max = 80 A × 240 V = 19.2 kW. 25 kW comfortably above both.
 *  Anything above this in a snapshot is the historical units bug
 *  (commit 129ee62 — wall_connector_power was multiplied by 1000 on
 *  the assumption it was kW, but it's actually W). */
const MAX_REASONABLE_EV_W = 25_000;

/** Auto-correct an evW reading: if it's above the residential ceiling,
 *  it's the pre-fix unit bug — divide by 1000 to recover the real W
 *  value. Idempotent: a correct value (≤ 25 kW) passes through
 *  unchanged. Used on read so historical bad rows don't poison
 *  rollups; the matching write-side migration 0006 cleans up the
 *  underlying data so this code path stays inert going forward. */
function sanitizeEvW(raw: number): number {
  if (raw > MAX_REASONABLE_EV_W) return raw / 1000;
  return Math.max(0, raw);
}

/** Total grid-import cost in USD over a rolling window. Sums (grid_import
 *  × tou_rate-at-snapshot) across every captured snapshot; the rate
 *  varies by hour so this correctly weights peak vs off-peak draws.
 *
 *  Imports only — does not subtract NEM 3.0 export credits. Export
 *  pricing under PG&E's NBT (Net Billing Tariff) varies hourly with
 *  the avoided-cost calculator and a flat rate would be misleading.
 *  Until we wire the NBT export-rate table, this number reads as
 *  "what you paid the grid", not "your net bill".
 *
 *  Returns 0 with no DB / no data — a clean "nothing yet" rather
 *  than null.
 */
export type CostWindow = "today" | "week" | "month";

export async function getGridCostUsd(window: CostWindow): Promise<number> {
  const db = getDb();
  if (!db) return 0;

  const { getRateAt } = await import("./rates");
  const now = new Date();
  let windowStart: Date;
  switch (window) {
    case "today":
      windowStart = ptStartOfToday(now);
      break;
    case "week":
      windowStart = new Date(ptStartOfToday(now).getTime() - 6 * 24 * 3600 * 1000);
      break;
    case "month":
      windowStart = new Date(ptStartOfToday(now).getTime() - 29 * 24 * 3600 * 1000);
      break;
  }

  const rows = await db
    .select({ capturedAt: energySnapshots.capturedAt, gridW: energySnapshots.gridW })
    .from(energySnapshots)
    .where(gte(energySnapshots.capturedAt, windowStart));

  if (rows.length === 0) return 0;

  const intervalH = 5 / 60;
  let costUsd = 0;
  for (const r of rows) {
    const importW = Math.max(0, r.gridW);
    if (importW === 0) continue;
    const importKwh = (importW * intervalH) / 1000;
    const { rate } = getRateAt(r.capturedAt);
    costUsd += importKwh * rate;
  }
  return +costUsd.toFixed(2);
}

/** Total kWh delivered to the EV since PT midnight. Same Riemann-sum
 *  shape as getSelfSufficiencyTodayPct: each cron snapshot is a 5-min
 *  power sample, integrate to energy. Returns 0 with no data — a
 *  cleaner "nothing charged today" than null. */
export async function getEvChargedTodayKwh(): Promise<number> {
  const db = getDb();
  if (!db) return 0;

  const ptMidnight = ptStartOfToday(new Date());
  const rows = await db
    .select({ evW: energySnapshots.evW })
    .from(energySnapshots)
    .where(gte(energySnapshots.capturedAt, ptMidnight));

  if (rows.length === 0) return 0;

  const intervalH = 5 / 60;
  let kwh = 0;
  for (const r of rows) {
    kwh += (sanitizeEvW(r.evW) * intervalH) / 1000;
  }
  return +kwh.toFixed(2);
}

export async function getEvSourceTodaySplit(): Promise<{ solar: number; grid: number }> {
  const db = getDb();
  if (!db) return { solar: 88, grid: 12 };

  const ptMidnight = ptStartOfToday(new Date());
  const rows = await db
    .select({ evW: energySnapshots.evW, gridW: energySnapshots.gridW })
    .from(energySnapshots)
    .where(gte(energySnapshots.capturedAt, ptMidnight));

  if (rows.length === 0) return { solar: 100, grid: 0 };

  const intervalH = 5 / 60;
  let onsiteKwh = 0;
  let gridKwh = 0;
  for (const r of rows) {
    const evW = sanitizeEvW(r.evW);
    if (evW <= 0) continue;
    const gridImport = Math.max(0, r.gridW);
    const evFromGrid = Math.min(evW, gridImport);
    const evFromOnsite = Math.max(0, evW - gridImport);
    gridKwh += (evFromGrid * intervalH) / 1000;
    onsiteKwh += (evFromOnsite * intervalH) / 1000;
  }

  const totalKwh = onsiteKwh + gridKwh;
  if (totalKwh <= 0) return { solar: 100, grid: 0 };

  const solarPct = Math.round((onsiteKwh / totalKwh) * 100);
  // Force the two numbers to sum to exactly 100 — Math.round can drift.
  return { solar: solarPct, grid: 100 - solarPct };
}

/** Compute today's self-sufficiency as an integer percent (0–100).
 *
 *  Returns 100 when there's no data yet (early-morning / fresh DB) —
 *  trivially "self-sufficient" because nothing's been consumed.
 *
 *  Returns 87 (the legacy mock value) when the DB isn't configured at
 *  all so local-dev / tests still see a sensible hero number. */
export async function getSelfSufficiencyTodayPct(): Promise<number> {
  const db = getDb();
  if (!db) return 87;

  const ptMidnight = ptStartOfToday(new Date());
  const rows = await db
    .select({
      homeW: energySnapshots.homeW,
      gridW: energySnapshots.gridW,
    })
    .from(energySnapshots)
    .where(gte(energySnapshots.capturedAt, ptMidnight));

  if (rows.length === 0) return 100;

  // Each cron snapshot represents 5 min of power at that level.
  const intervalH = 5 / 60;
  let totalHomeKwh = 0;
  let totalGridImportKwh = 0;
  for (const r of rows) {
    totalHomeKwh += (r.homeW * intervalH) / 1000;
    totalGridImportKwh += (Math.max(0, r.gridW) * intervalH) / 1000;
  }

  if (totalHomeKwh <= 0) return 100;

  const pct = ((totalHomeKwh - totalGridImportKwh) / totalHomeKwh) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/**
 * Rolling 30-day average of home_w by hour-of-day in PT, returned as a
 * 24-element kW array indexed [hour 0 = midnight PT … hour 23 = 11 PM PT].
 *
 * Returns null in three cases:
 *   - no DB connected (dev mode)
 *   - fewer than MIN_SAMPLE_DAYS distinct days of data (curve would be
 *     too noisy; caller should fall back to the static synthetic curve
 *     in mock.ts)
 *   - any hour bucket has < MIN_SAMPLES_PER_HOUR points (single weird
 *     day would dominate that hour; not personalized enough yet)
 *
 * Why hour-of-day in PT and not raw UTC: the user's life is paced in PT.
 * Their evening cooking peak is 6–8 PM PT regardless of DST. Aggregating
 * by UTC hour would smear the peak across a 1-hour window when DST shifts.
 *
 * Why 30 days: long enough to smooth out one-off events (party, guest
 * visit), short enough to track seasonal HVAC changes.
 *
 * Cost: single grouped query over ~8,640 rows (30d × 288 ticks/day) with
 * an index on captured_at. Sub-50ms on Neon's smallest tier; cheap
 * enough to call from every assembleStatus() invocation. If this ever
 * becomes hot we'll memoize per request or move to a stored
 * learned_models table refreshed nightly.
 */
const LEARNED_CURVE_WINDOW_DAYS = 30;
const LEARNED_CURVE_MIN_SAMPLE_DAYS = 7;
const LEARNED_CURVE_MIN_SAMPLES_PER_HOUR = 12; // ~1h of 5-min snapshots

export async function getLearnedHomeCurve(): Promise<number[] | null> {
  const db = getDb();
  if (!db) return null;

  const TZ = "America/Los_Angeles";
  const windowStart = new Date(
    Date.now() - LEARNED_CURVE_WINDOW_DAYS * 24 * 3600 * 1000,
  );

  // One row per hour-of-day, with the average wattage and the count of
  // contributing snapshots. We also pull a global distinct-day count
  // off the same query so we can decide gating once instead of doing a
  // second roundtrip.
  type Row = { hour: number; avg_w: number; samples: number };
  const rows = (await db.execute(
    sql`
      SELECT
        EXTRACT(HOUR FROM (${energySnapshots.capturedAt} AT TIME ZONE ${TZ}))::int AS hour,
        AVG(${energySnapshots.homeW})::float8 AS avg_w,
        COUNT(*)::int AS samples
      FROM ${energySnapshots}
      WHERE ${energySnapshots.capturedAt} >= ${windowStart}
      GROUP BY hour
      ORDER BY hour
    `,
  )) as unknown as Row[];

  if (rows.length === 0) return null;

  // Sample-day gate: count distinct PT calendar days in the window.
  // Cheap second query, only fires when we actually have data.
  type CountRow = { days: number };
  const dayRows = (await db.execute(
    sql`
      SELECT COUNT(DISTINCT (${energySnapshots.capturedAt} AT TIME ZONE ${TZ})::date)::int AS days
      FROM ${energySnapshots}
      WHERE ${energySnapshots.capturedAt} >= ${windowStart}
    `,
  )) as unknown as CountRow[];
  const distinctDays = dayRows[0]?.days ?? 0;
  if (distinctDays < LEARNED_CURVE_MIN_SAMPLE_DAYS) return null;

  // Build the 24-element output. Hours that exist get the learned
  // value; hours with insufficient samples (system was down for that
  // window) get null and we abort to the static fallback — better to
  // show a clean "approximation" than a curve with gaps.
  const out: (number | null)[] = Array.from({ length: 24 }, () => null);
  for (const r of rows) {
    if (r.samples < LEARNED_CURVE_MIN_SAMPLES_PER_HOUR) continue;
    out[r.hour] = +(r.avg_w / 1000).toFixed(2);
  }
  if (out.some((v) => v === null)) return null;

  return out as number[];
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
    automation_enabled: row.automationEnabled,
    ev_solar_boost_cap_pct: row.evSolarBoostCapPct,
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
  if (p.automation_enabled !== undefined) u.automationEnabled = p.automation_enabled;
  if (p.ev_solar_boost_cap_pct !== undefined) u.evSolarBoostCapPct = p.ev_solar_boost_cap_pct;
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
