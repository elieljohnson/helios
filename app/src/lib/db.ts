// Storage layer. When DATABASE_URL is set we talk to Postgres via Drizzle;
// otherwise we keep an in-memory log so dev + tests work without a DB.
// Every consumer (route handlers, cron) uses the async API below — the
// swap happens behind this boundary.

import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  controlActions,
  dailySummaries,
  energySnapshots,
  evChargeSessions,
  forecastSnapshots,
  oauthTokens,
  userConfig,
  type OAuthProvider,
} from "@/db/schema";
import { DEFAULT_CONFIG } from "./config";
import {
  attributeEvDraw,
  attributePwCharge,
  attributePwDischarge,
  TICK_HOURS,
  wattsToKwh,
} from "./sourceAttribution";
import type {
  ActionEntry,
  ActionType,
  ConfigResponse,
  EnergySnapshot,
  ForecastResponse,
} from "./types";

type AppendAction = {
  type: ActionType;
  title: string;
  reason: string;
  ok: boolean;
  /** Target value the action set (e.g. reserve %, desired charge kW). */
  targetValue?: number | null;
  /** Pre-action value, for delta display in the activity log. */
  prevValue?: number | null;
  /** Structured projection metadata (migration 0014). Populated for
   *  EV decision rows; null for reserve writes / info / alert. Lets
   *  future trend screens query the engine's reasoning as data,
   *  not as parsed reason-text. */
  zone?: "comfort" | "caution" | "defend" | null;
  evChargeLimitPct?: number | null;
  projectedEndPwPct?: number | null;
  projectedDeparturePwPct?: number | null;
  mode?: "parked" | "driving" | null;
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
        zone: entry.zone ?? null,
        evChargeLimitPct: entry.evChargeLimitPct ?? null,
        projectedEndPwPct: entry.projectedEndPwPct ?? null,
        projectedDeparturePwPct: entry.projectedDeparturePwPct ?? null,
        mode: entry.mode ?? null,
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

// --- Recommendation dedup -------------------------------------------
//
// Under Option B, every cron tick computes an EvRecommendation. We
// only want to write it to the activity feed (and push it) when the
// user-visible meaning has changed — otherwise the feed turns into
// a 5-min wallpaper.
//
// `recommendEvAction` produces a stable `signature` string for that
// purpose. We persist it alongside the action without a schema
// migration by appending a trailing marker line to `reason`:
//
//   <body>
//   [helios-sig:<signature>]
//
// `appendRecommendation` writes that shape; `lastRecommendationSignature`
// reads back the most recent charge-typed action and parses out the
// marker. `/api/actions` strips the marker line before sending to the
// UI so the feed displays clean copy.

// Recommendation reasons may carry one OR two trailing marker lines:
//   [helios-sig:<signature>]              — always
//   [helios-pushed:<ISO timestamp>]        — only if a Web Push fired
//
// Markers are stripped at the API edge (/api/actions) so the UI sees
// clean copy. Order is fixed (sig first, push-time second) so the
// regexes can be anchored.
const SIG_MARKER_RE = /\n\[helios-sig:([^\]\n]+)\]/;
const PUSH_MARKER_RE = /\n\[helios-pushed:([^\]\n]+)\]/;
const ALL_MARKERS_RE = /\n\[helios-(sig|pushed):[^\]\n]+\]/g;

export function stripSignatureMarker(reason: string): string {
  return reason.replace(ALL_MARKERS_RE, "");
}

function extractSignature(reason: string): string | null {
  const m = SIG_MARKER_RE.exec(reason);
  return m ? m[1] : null;
}

function extractPushTimestamp(reason: string): string | null {
  const m = PUSH_MARKER_RE.exec(reason);
  return m ? m[1] : null;
}

/** Append a `charge`-typed action whose reason embeds the recommendation
 *  signature for next-tick dedup. Body and signature are passed
 *  separately so the marker is appended exactly once at write time.
 *  When `pushedAt` is provided, a second marker records the push time
 *  for the throttle in lastPushTimestamp(). */
export async function appendRecommendation(rec: {
  title: string;
  body: string;
  signature: string;
  ok: boolean;
  pushedAt?: Date | null;
  targetValue?: number | null;
  prevValue?: number | null;
  // Structured projection metadata. Plumbed through to control_actions
  // for trend-analysis queries that don't want to parse reason text.
  zone?: "comfort" | "caution" | "defend" | null;
  evChargeLimitPct?: number | null;
  projectedEndPwPct?: number | null;
  projectedDeparturePwPct?: number | null;
  mode?: "parked" | "driving" | null;
}): Promise<ActionEntry> {
  const sigLine = `\n[helios-sig:${rec.signature}]`;
  const pushLine = rec.pushedAt
    ? `\n[helios-pushed:${rec.pushedAt.toISOString()}]`
    : "";
  return appendAction({
    type: "charge",
    title: rec.title,
    reason: `${rec.body}${sigLine}${pushLine}`,
    ok: rec.ok,
    targetValue: rec.targetValue ?? null,
    prevValue: rec.prevValue ?? null,
    zone: rec.zone ?? null,
    evChargeLimitPct: rec.evChargeLimitPct ?? null,
    projectedEndPwPct: rec.projectedEndPwPct ?? null,
    projectedDeparturePwPct: rec.projectedDeparturePwPct ?? null,
    mode: rec.mode ?? null,
  });
}

/** Returns the signature on the most recent charge-typed action, or
 *  null if there isn't one (or it lacks a marker — e.g. from an older
 *  Helios version pre-Option-B). */
export async function lastRecommendationSignature(): Promise<string | null> {
  const db = getDb();
  if (db) {
    const [row] = await db
      .select()
      .from(controlActions)
      .where(eq(controlActions.type, "charge"))
      .orderBy(desc(controlActions.occurredAt))
      .limit(1);
    return row ? extractSignature(row.reason) : null;
  }
  // In-memory log stores ActionEntry, whose `reason` already includes
  // the marker (toEntry doesn't strip — strip happens at the API edge).
  const last = memoryLog.find((a) => a.type === "charge");
  return last ? extractSignature(last.reason) : null;
}

/** Returns the timestamp of the most recent push that fired (parsed
 *  from the trailing [helios-pushed:…] marker), or null if no push
 *  has fired in the recent log. Walks back 20 entries — push markers
 *  may be on a charge entry several recommendations ago. */
export async function lastPushTimestamp(): Promise<Date | null> {
  const db = getDb();
  let candidates: { reason: string }[];
  if (db) {
    candidates = await db
      .select({ reason: controlActions.reason })
      .from(controlActions)
      .where(eq(controlActions.type, "charge"))
      .orderBy(desc(controlActions.occurredAt))
      .limit(20);
  } else {
    candidates = memoryLog.filter((a) => a.type === "charge").slice(0, 20);
  }
  for (const c of candidates) {
    const iso = extractPushTimestamp(c.reason);
    if (iso) return new Date(iso);
  }
  return null;
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
  /** Gross grid imports priced at the per-snapshot TOU rate, summed
   *  over the window. Positive number — what the user paid PG&E for
   *  energy during this period. NOT netted against exports. */
  import_usd: number;
  /** Gross grid exports priced at the flat NBT (NEM 3.0) export rate,
   *  summed over the window. Positive number — credit earned. NOT
   *  netted against imports. The two numbers together are more
   *  informative than the net (which the dashboard CostCard already
   *  shows): users want to see both how much they spent AND how much
   *  the panels earned them, separately. */
  export_credit_usd: number;
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
  if (!db)
    return { period, headline_pct: 87, points: [], import_usd: 0, export_credit_usd: 0 };

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

  // --- Cost breakdown ($ spent + NEM credits earned) ---
  // Pulls raw per-snapshot grid power across the same window, prices
  // imports at the TOU rate active at each snapshot, exports at the
  // flat NBT rate. Returns the gross imports and gross export credits
  // separately (not netted) — both are what the user wants to see at
  // week/month/year scope, and the dashboard's CostCard already
  // covers the net daily number.
  const { getRateAt } = await import("./rates");
  const config = await getConfig();
  const exportRate = config.nem_export_rate_per_kwh;
  const intervalH = 5 / 60; // cron tick is 5 min
  const costRows = await db
    .select({
      capturedAt: energySnapshots.capturedAt,
      gridW: energySnapshots.gridW,
    })
    .from(energySnapshots)
    .where(gte(energySnapshots.capturedAt, windowStart));
  let importUsd = 0;
  let exportCreditUsd = 0;
  for (const r of costRows) {
    if (r.gridW > 0) {
      const importKwh = (r.gridW * intervalH) / 1000;
      importUsd += importKwh * getRateAt(r.capturedAt).rate;
    } else if (r.gridW < 0) {
      const exportKwh = (-r.gridW * intervalH) / 1000;
      exportCreditUsd += exportKwh * exportRate;
    }
  }

  return {
    period,
    headline_pct,
    points,
    import_usd: +importUsd.toFixed(2),
    export_credit_usd: +exportCreditUsd.toFixed(2),
  };
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

/** Net grid cost in USD over a rolling window: imports priced at the
 *  TOU rate active at each snapshot, MINUS exports priced at a flat
 *  NEM 3.0 export rate. The signed result lets the dashboard display
 *  positive (you spent) and negative (you earned credit) values
 *  consistently.
 *
 *  Imports vary by TOU period (off-peak / peak) and integrate at the
 *  rate active at each snapshot's captured_at — so a peak import is
 *  weighted higher than an off-peak one. Exports use a flat rate
 *  (PG&E's NBT Avoided Cost Calculator publishes an hourly value;
 *  a yearly average ~$0.04/kWh is a fine approximation until we wire
 *  the hourly table).
 *
 *  Important caveat the UI should communicate: NEM 3.0 credits are
 *  not cash. They offset future imports at annual true-up; you can't
 *  end the year with a net check from PG&E. So a negative number here
 *  means "credit accruing" not "money in your pocket."
 *
 *  Returns 0 with no DB / no data — a clean "nothing yet" rather than
 *  null.
 */
export type CostWindow = "today" | "week" | "month";

export async function getGridCostUsd(
  window: CostWindow,
  exportRatePerKwh: number,
): Promise<number> {
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
    if (r.gridW > 0) {
      // Import: weighted by TOU rate at this snapshot.
      const importKwh = (r.gridW * intervalH) / 1000;
      const { rate } = getRateAt(r.capturedAt);
      costUsd += importKwh * rate;
    } else if (r.gridW < 0) {
      // Export: flat NBT rate. Subtract from cost so net can go negative.
      const exportKwh = (-r.gridW * intervalH) / 1000;
      costUsd -= exportKwh * exportRatePerKwh;
    }
  }
  return +costUsd.toFixed(2);
}

/** Gross export kWh over the window. Used by the Cost card to show
 *  how much of the displayed credit came from exports (separate from
 *  the net-cost number). Returns 0 with no data.
 */
export async function getGridExportKwh(window: CostWindow): Promise<number> {
  const db = getDb();
  if (!db) return 0;

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
    .select({ gridW: energySnapshots.gridW })
    .from(energySnapshots)
    .where(gte(energySnapshots.capturedAt, windowStart));

  if (rows.length === 0) return 0;

  const intervalH = 5 / 60;
  let kwh = 0;
  for (const r of rows) {
    if (r.gridW < 0) kwh += (-r.gridW * intervalH) / 1000;
  }
  return +kwh.toFixed(2);
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
  // postgres-js rejects raw Date objects as parameter values
  // (TypeError: "string" argument must be of type string or Buffer);
  // serialize to ISO before binding. Caught silently before, but the
  // failed query was costing ~100ms per /api/status request — fix
  // restores the learned curve and shaves the latency.
  const windowStart = new Date(
    Date.now() - LEARNED_CURVE_WINDOW_DAYS * 24 * 3600 * 1000,
  ).toISOString();

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
      // Migration 0019. Persist the real plug state so prev-tick reads
      // by Gate 1b (decideEvCharge plug-state flap guard) get an
      // honest value instead of a hardcoded fallback.
      evPluggedIn: s.ev_plugged_in,
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
    surplus_forecast_kwh: row.surplusForecastKwh,
    morning_pw_floor_pct: row.morningPwFloorPct,
    nem_export_rate_per_kwh: row.nemExportRatePerKwh,
    morning_bridge_floor_pct: row.morningBridgeFloorPct,
    // Not yet a DB column — fall back to the default. Adding a
    // migration (and exposing the field in Settings) is a follow-on
    // task; for now every user reads the same hardcoded margin.
    pw_sunset_safety_margin_pct: DEFAULT_CONFIG.pw_sunset_safety_margin_pct,
    // Same fallback pattern: home_geofence_radius_m hardcoded until
    // a Settings card lands. The geofence is on by default at 200 m.
    home_geofence_radius_m: DEFAULT_CONFIG.home_geofence_radius_m,
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
  if (p.surplus_forecast_kwh !== undefined) u.surplusForecastKwh = p.surplus_forecast_kwh;
  if (p.morning_pw_floor_pct !== undefined) u.morningPwFloorPct = p.morning_pw_floor_pct;
  if (p.nem_export_rate_per_kwh !== undefined) u.nemExportRatePerKwh = p.nem_export_rate_per_kwh;
  if (p.morning_bridge_floor_pct !== undefined) u.morningBridgeFloorPct = p.morning_bridge_floor_pct;
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

// --- Morning PW low analysis ----------------------------------------
// One-shot query for "what was my lowest overnight PW SoC each day for
// the past N days?" Used to inform pw_sunset_target_pct tuning — if
// the actual overnight low is comfortably above the target, the target
// is conservative and could be lowered to free up daytime EV budget.
//
// "Morning" defined as PT [00:00, 08:00) — captures the overnight
// drain plus the pre-solar dip before sunrise. pw_soc tends to bottom
// somewhere in this window on most days.

export type MorningPwLow = {
  /** PT date (YYYY-MM-DD). */
  date: string;
  /** Lowest pw_soc % observed in the morning window. Null if no
   *  snapshots existed for that day's window (cron offline, fresh
   *  install, etc). */
  min_pw_soc: number | null;
  /** Hour PT at which the min was observed. Helps spot patterns
   *  (e.g., always at 06:00 = consistent overnight bottom). */
  min_at_hour_pt: number | null;
  /** How many snapshots fell in the morning window — sanity check
   *  against partial data. Full coverage = 96 (every 5 min × 8h). */
  sample_count: number;
};

export async function getMorningPwLows(days: number): Promise<MorningPwLow[]> {
  const db = getDb();
  if (!db) return [];
  const TZ = "America/Los_Angeles";

  // Window: from N days ago at PT 00:00, up to now. Bind as ISO
  // string — postgres-js rejects raw Date objects as parameter
  // values (same gotcha as getLearnedHomeCurve).
  const now = new Date();
  const todayStart = ptStartOfToday(now);
  const windowStart = new Date(
    todayStart.getTime() - (days - 1) * 24 * 3600 * 1000,
  ).toISOString();

  // One row per PT date in the window. array_agg(... ORDER BY pw_soc
  // ASC, hour ASC)[1] gives the hour at which the minimum pw_soc
  // first occurred — handles ties deterministically (earliest hour).
  type Row = {
    pt_date: string;
    min_pw_soc: number;
    min_at_hour_pt: number;
    sample_count: number;
  };
  const rows = (await db.execute(
    sql`
      SELECT
        TO_CHAR(${energySnapshots.capturedAt} AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS pt_date,
        MIN(${energySnapshots.pwSoc})::float8 AS min_pw_soc,
        (array_agg(
          EXTRACT(HOUR FROM (${energySnapshots.capturedAt} AT TIME ZONE ${TZ}))::int
          ORDER BY ${energySnapshots.pwSoc} ASC,
                   EXTRACT(HOUR FROM (${energySnapshots.capturedAt} AT TIME ZONE ${TZ})) ASC
        ))[1] AS min_at_hour_pt,
        COUNT(*)::int AS sample_count
      FROM ${energySnapshots}
      WHERE ${energySnapshots.capturedAt} >= ${windowStart}
        AND EXTRACT(HOUR FROM (${energySnapshots.capturedAt} AT TIME ZONE ${TZ}))::int < 8
      GROUP BY pt_date
      ORDER BY pt_date DESC
    `,
  )) as unknown as Row[];

  return rows.map((r) => ({
    date: r.pt_date,
    min_pw_soc: r.min_pw_soc,
    min_at_hour_pt: r.min_at_hour_pt,
    sample_count: r.sample_count,
  }));
}

export async function deleteToken(provider: OAuthProvider): Promise<void> {
  const db = getDb();
  if (db) {
    await db.delete(oauthTokens).where(eq(oauthTokens.provider, provider));
    return;
  }
  memoryTokens.delete(provider);
}

// --- EV charge session detection ------------------------------------
// Called by the cron route on every tick. Detects ev_charging
// false→true transitions (open a session) and true→false transitions
// (close + finalize). On every tick during an open session,
// accumulates the per-tick energy and source-split attribution into
// the open row.
//
// State is tracked in the table itself: at most one row at a time
// has ended_at = NULL. Idempotent against missed ticks (each tick
// re-detects the state from the snapshot, not from a memory marker).

export async function detectEvSession(opts: {
  prevSnapshot: EnergySnapshot | null;
  snapshot: EnergySnapshot;
  capturedAt: Date;
  /** Today's tou_rate at this tick — used for the cost integral. */
  touRate: number;
  /** Day classification for sessions opened this tick. */
  dayKind?: "parked" | "driving" | null;
  /** control_actions row id that authorized this start (if any). */
  authorizingActionId?: number | null;
}): Promise<void> {
  const db = getDb();
  if (!db) return; // memory-only mode: skip session tracking
  const { prevSnapshot, snapshot, capturedAt, touRate } = opts;

  const wasCharging = prevSnapshot?.ev_charging ?? false;
  const isCharging = snapshot.ev_charging;

  // Find any currently-open session (ended_at = NULL).
  const [openSession] = await db
    .select()
    .from(evChargeSessions)
    .where(isNull(evChargeSessions.endedAt))
    .orderBy(desc(evChargeSessions.startedAt))
    .limit(1);

  if (isCharging && !wasCharging && !openSession) {
    // Open a new session.
    await db.insert(evChargeSessions).values({
      startedAt: capturedAt,
      startSocPct: snapshot.ev_soc,
      kwhDelivered: 0,
      solarKwh: 0,
      pwKwh: 0,
      gridKwh: 0,
      peakRateKw: 0,
      avgRateKw: 0,
      costUsd: 0,
      dayKind: opts.dayKind ?? null,
      authorizingActionId: opts.authorizingActionId ?? null,
    });
    return;
  }

  if (isCharging && openSession) {
    // Accumulate this tick's contribution to the open session.
    const ev = attributeEvDraw(snapshot);
    const tickKwh = wattsToKwh(ev.split, TICK_HOURS);
    const totalTickKwh = tickKwh.solar + tickKwh.pw + tickKwh.grid;
    const tickRateKw = ev.load_w / 1000;
    const newPeakKw = Math.max(openSession.peakRateKw, tickRateKw);
    const newKwhDelivered = openSession.kwhDelivered + totalTickKwh;
    // avg_rate_kw is finalized at close; here we just keep a running
    // estimate based on duration so far.
    const elapsedH =
      (capturedAt.getTime() - openSession.startedAt.getTime()) / 3_600_000;
    const newAvgKw = elapsedH > 0 ? newKwhDelivered / elapsedH : 0;
    // Cost: this tick's grid_kwh × current touRate.
    const newCost = openSession.costUsd + tickKwh.grid * touRate;
    await db
      .update(evChargeSessions)
      .set({
        kwhDelivered: newKwhDelivered,
        solarKwh: openSession.solarKwh + tickKwh.solar,
        pwKwh: openSession.pwKwh + tickKwh.pw,
        gridKwh: openSession.gridKwh + tickKwh.grid,
        peakRateKw: newPeakKw,
        avgRateKw: newAvgKw,
        costUsd: newCost,
      })
      .where(eq(evChargeSessions.id, openSession.id));
    return;
  }

  if (!isCharging && openSession) {
    // Close out. duration_min and end_soc_pct stamped here.
    const durationMin =
      (capturedAt.getTime() - openSession.startedAt.getTime()) / 60_000;
    const finalAvgKw =
      durationMin > 0 ? openSession.kwhDelivered / (durationMin / 60) : 0;
    await db
      .update(evChargeSessions)
      .set({
        endedAt: capturedAt,
        durationMin,
        endSocPct: snapshot.ev_soc,
        avgRateKw: finalAvgKw,
      })
      .where(eq(evChargeSessions.id, openSession.id));
  }
}

/** Returns the most recent snapshot in the DB, or null if none. Used
 *  by the cron tick to detect ev_charging transitions for session
 *  tracking. */
export async function getMostRecentSnapshot(): Promise<EnergySnapshot | null> {
  const db = getDb();
  if (db) {
    const [row] = await db
      .select()
      .from(energySnapshots)
      .orderBy(desc(energySnapshots.capturedAt))
      .limit(1);
    if (!row) return null;
    return rowToSnapshot(row);
  }
  return memorySnapshots[0]?.snapshot ?? null;
}

function rowToSnapshot(
  row: typeof energySnapshots.$inferSelect,
): EnergySnapshot {
  // Minimal projection for fields the session detector needs.
  // Other consumers should use the full status pipeline.
  return {
    self_sufficiency: row.selfSufficiency ?? 0,
    status_word: "",
    solar_w: row.solarW,
    home_w: row.homeW,
    ev_w: row.evW,
    pw_w: row.pwW,
    grid_w: row.gridW,
    grid_direction: row.gridW > 0 ? "import" : row.gridW < 0 ? "export" : "idle",
    ev_soc: row.evSoc ?? 0,
    ev_target: 80,
    ev_range: 0,
    ev_charging: row.evCharging,
    // Migration 0019 added the column; this reads the persisted value.
    // Pre-migration historical rows default to TRUE (the common case).
    ev_plugged_in: row.evPluggedIn,
    ev_source: { solar: 0, grid: 0 },
    ev_charged_today_kwh: 0,
    pw_soc: row.pwSoc,
    pw_reserve: row.pwReserve,
    pw_mode: "",
    tou_period: row.touPeriod as EnergySnapshot["tou_period"],
    tou_rate: row.touRate,
    nem_export_rate: 0.04,
    daily_cost: 0,
    week_cost: 0,
    month_cost: 0,
    daily_export_kwh: 0,
  };
}

// --- Forecast snapshot capture --------------------------------------
// Capture once per PT day (first cron tick of the day) PLUS on
// meaningful Open-Meteo revisions where daily_kwh changed by ≥
// FORECAST_REVISION_DELTA_KWH from the previous capture. Most days
// produce 1–3 rows; very volatile forecast days might produce a
// handful more.

const FORECAST_REVISION_DELTA_KWH = 5;

export async function captureForecastSnapshot(opts: {
  forecast: ForecastResponse;
  now: Date;
}): Promise<void> {
  const db = getDb();
  if (!db) return;
  const { forecast, now } = opts;

  // Determine forecast_for_date from forecast.daily[0].day if present;
  // fall back to today's PT date.
  const forecastForDate = ptDateString(now);
  const today = forecast.daily[0];
  if (!today) return;

  // Most-recent capture for this date.
  const [latest] = await db
    .select()
    .from(forecastSnapshots)
    .where(eq(forecastSnapshots.forecastForDate, forecastForDate))
    .orderBy(desc(forecastSnapshots.revisionNumber))
    .limit(1);

  // Check the revision threshold.
  if (latest) {
    const delta = Math.abs(today.kwh - latest.dailyKwh);
    if (delta < FORECAST_REVISION_DELTA_KWH) {
      // No meaningful change; skip.
      return;
    }
  }

  const hourlySolar = forecast.hourly.map((h) => h.solar);
  const sunriseAt = today.sunrise ? new Date(today.sunrise) : null;
  const sunsetAt = today.sunset ? new Date(today.sunset) : null;
  await db.insert(forecastSnapshots).values({
    capturedAt: now,
    forecastForDate,
    dailyKwh: today.kwh,
    dailyHighF: today.high ?? null,
    dailyLowF: today.low ?? null,
    dailyCloudPct: today.cloud ?? null,
    hourlySolarKw: hourlySolar,
    sunriseAt,
    sunsetAt,
    revisionNumber: latest ? latest.revisionNumber + 1 : 0,
  });
}

function ptDateString(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: HELIOS_DISPLAY_TZ,
  }).format(d);
}

// --- Daily summaries rollup -----------------------------------------
// Runs at the first cron tick after PT midnight. Integrates the
// previous day's snapshots into one daily_summaries row with all
// the columns the future trend screens need: production totals,
// EV source split, PW flow attribution, peaks, hours-self-sufficient,
// forecast vs actual.
//
// Idempotent: ON CONFLICT DO NOTHING on the date PK ensures repeated
// calls don't double-write.

export async function rollupYesterday(opts: { now: Date }): Promise<void> {
  const db = getDb();
  if (!db) return;
  const { now } = opts;

  // Compute "yesterday" in PT.
  const yesterdayPt = ptDateOffset(now, -1);
  // Skip if already rolled up.
  const [existing] = await db
    .select({ date: dailySummaries.date })
    .from(dailySummaries)
    .where(eq(dailySummaries.date, yesterdayPt))
    .limit(1);
  if (existing) return;

  // PT midnight boundaries → UTC. Use the offset trick.
  const startUtc = ptMidnightUtc(yesterdayPt);
  const endUtc = ptMidnightUtc(ptDateOffset(now, 0)); // today's PT midnight

  // Pull all snapshots in window.
  const rows = await db
    .select()
    .from(energySnapshots)
    .where(
      and(
        gte(energySnapshots.capturedAt, startUtc),
        lt(energySnapshots.capturedAt, endUtc),
      ),
    )
    .orderBy(energySnapshots.capturedAt);

  if (rows.length === 0) return; // no data, nothing to summarize

  // Walk and integrate.
  let producedKwh = 0;
  let consumedKwh = 0;
  let gridImportKwh = 0;
  let gridExportKwh = 0;
  let evChargedKwh = 0;
  let evSolarKwh = 0;
  let evPwKwh = 0;
  let evGridKwh = 0;
  let pwChargedFromSolarKwh = 0;
  let pwChargedFromGridKwh = 0;
  let pwDischargedToHomeKwh = 0;
  let pwDischargedToEvKwh = 0;
  let peakSolarKw = 0;
  let peakHomeKw = 0;
  let peakEvKw = 0;
  let costUsd = 0;
  let exportKwhForCredit = 0;
  // hours_self_sufficient: count of full hours where every snapshot
  // in that hour had grid_w == 0. Approximated by counting snapshots
  // with grid_w == 0 and dividing by snapshots-per-hour.
  let selfSufficientTicks = 0;
  // Overnight PW endpoints (migration 0018). Captured per-day so a
  // future learned-overnight-target feature can compute night-by-
  // night drain patterns. Engine continues to use the static
  // pw_sunset_target_pct config — these are pure observational data.
  //
  // Morning window: PT 00:00–08:00 — captures the overnight bottom
  // before solar starts producing meaningfully.
  // Evening window: PT 14:00–22:00 — captures the sunset peak,
  // i.e., what the engine actually delivered against the target.
  let morningLowPwPct: number | null = null;
  let morningLowAtHourPt: number | null = null;
  let eveningHighPwPct: number | null = null;
  let eveningHighAtHourPt: number | null = null;

  for (const row of rows) {
    const snap = rowToSnapshot(row);
    const ptHour = ptHourOfTimestamp(row.capturedAt);
    producedKwh += (snap.solar_w / 1000) * TICK_HOURS;
    consumedKwh += (snap.home_w / 1000) * TICK_HOURS;
    if (snap.grid_w > 0) {
      gridImportKwh += (snap.grid_w / 1000) * TICK_HOURS;
      costUsd += (snap.grid_w / 1000) * TICK_HOURS * snap.tou_rate;
    } else if (snap.grid_w < 0) {
      const exp = (-snap.grid_w / 1000) * TICK_HOURS;
      gridExportKwh += exp;
      exportKwhForCredit += exp;
    } else {
      selfSufficientTicks++;
    }
    // EV split.
    const ev = attributeEvDraw(snap);
    const evK = wattsToKwh(ev.split, TICK_HOURS);
    evChargedKwh += evK.solar + evK.pw + evK.grid;
    evSolarKwh += evK.solar;
    evPwKwh += evK.pw;
    evGridKwh += evK.grid;
    // PW charge (pw_w < 0).
    const pwIn = attributePwCharge(snap);
    const pwInK = wattsToKwh(pwIn.split, TICK_HOURS);
    pwChargedFromSolarKwh += pwInK.solar;
    pwChargedFromGridKwh += pwInK.grid;
    // PW discharge (pw_w > 0).
    const pwOut = attributePwDischarge(snap);
    pwDischargedToEvKwh += (pwOut.toEv / 1000) * TICK_HOURS;
    pwDischargedToHomeKwh += (pwOut.toHome / 1000) * TICK_HOURS;
    // Peaks.
    peakSolarKw = Math.max(peakSolarKw, snap.solar_w / 1000);
    peakHomeKw = Math.max(peakHomeKw, snap.home_w / 1000);
    peakEvKw = Math.max(peakEvKw, snap.ev_w / 1000);
    // Morning low / evening high (migration 0018).
    if (ptHour < 8) {
      if (morningLowPwPct === null || snap.pw_soc < morningLowPwPct) {
        morningLowPwPct = snap.pw_soc;
        morningLowAtHourPt = ptHour;
      }
    }
    if (ptHour >= 14 && ptHour < 22) {
      if (eveningHighPwPct === null || snap.pw_soc > eveningHighPwPct) {
        eveningHighPwPct = snap.pw_soc;
        eveningHighAtHourPt = ptHour;
      }
    }
  }

  const ticksPerHour = 12; // 5-min intervals
  const hoursSelfSufficient = Math.round(selfSufficientTicks / ticksPerHour);

  // self_sufficiency: % of consumption met by non-grid sources.
  const selfSufficiency =
    consumedKwh > 0
      ? Math.max(
          0,
          Math.min(100, ((consumedKwh - gridImportKwh) / consumedKwh) * 100),
        )
      : 100;

  // Net cost: imports priced at TOU, minus export credit at flat rate.
  const config = await getConfig();
  const dailyCost = costUsd - exportKwhForCredit * config.nem_export_rate_per_kwh;

  // Forecast vs actual: pull the morning capture for yesterday.
  const [forecast] = await db
    .select()
    .from(forecastSnapshots)
    .where(eq(forecastSnapshots.forecastForDate, yesterdayPt))
    .orderBy(forecastSnapshots.revisionNumber)
    .limit(1);
  const forecastKwh = forecast?.dailyKwh ?? null;
  const forecastErrorPct =
    forecastKwh && forecastKwh > 0
      ? ((producedKwh - forecastKwh) / forecastKwh) * 100
      : null;

  await db.insert(dailySummaries).values({
    date: yesterdayPt,
    producedKwh,
    consumedKwh,
    gridImportKwh,
    gridExportKwh,
    selfSufficiency,
    dailyCost,
    dailySavings: 0, // deprecated field; left at 0
    evChargedKwh,
    evSolarKwh,
    evPwKwh,
    evGridKwh,
    pwChargedFromSolarKwh,
    pwChargedFromGridKwh,
    pwDischargedToHomeKwh,
    pwDischargedToEvKwh,
    peakSolarKw,
    peakHomeKw,
    peakEvKw,
    hoursSelfSufficient,
    forecastKwh,
    actualKwh: producedKwh,
    forecastErrorPct,
    morningLowPwPct,
    morningLowAtHourPt,
    eveningHighPwPct,
    eveningHighAtHourPt,
  });
}

/** PT hour 0–23 for a given UTC timestamp. Used by rollupYesterday()
 *  to bucket snapshots into morning / evening windows. */
function ptHourOfTimestamp(d: Date): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hour12: false,
      timeZone: HELIOS_DISPLAY_TZ,
    }).format(d),
    10,
  );
}

/** YYYY-MM-DD in PT, offset days from `now` (negative = past). */
function ptDateOffset(now: Date, offsetDays: number): string {
  const d = new Date(now.getTime() + offsetDays * 86_400_000);
  return ptDateString(d);
}

/** Convert a YYYY-MM-DD PT date to the UTC instant of midnight PT.
 *  Naive: assumes the offset is fixed for the date (PDT or PST). For
 *  the rollup that's fine; we only care about whole days. */
function ptMidnightUtc(ptYmd: string): Date {
  // Build a "YYYY-MM-DDT00:00:00" string and let Date parse it as
  // UTC, then shift by the PT offset. Compute the offset from a
  // sample date in the year (good enough for non-DST-boundary days).
  const sample = new Date(`${ptYmd}T12:00:00Z`);
  const ptHour = parseInt(
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hour12: false,
      timeZone: HELIOS_DISPLAY_TZ,
    }).format(sample),
    10,
  );
  // Offset minutes: 12 (UTC noon) minus PT hour, times 60.
  const offsetMin = (12 - ptHour) * 60;
  // PT midnight in UTC = midnight UTC + offset (PT is west of UTC,
  // so PT midnight happens AFTER UTC midnight on the same calendar
  // day).
  const utcMidnight = new Date(`${ptYmd}T00:00:00Z`).getTime();
  return new Date(utcMidnight + offsetMin * 60_000);
}
