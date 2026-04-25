// Storage layer. When DATABASE_URL is set we talk to Postgres via Drizzle;
// otherwise we keep an in-memory log so dev + tests work without a DB.
// Every consumer (route handlers, cron) uses the async API below — the
// swap happens behind this boundary.

import { desc } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { controlActions, energySnapshots } from "@/db/schema";
import type { ActionEntry, ActionType, EnergySnapshot } from "./types";

type AppendAction = {
  type: ActionType;
  title: string;
  reason: string;
  ok: boolean;
};

// Lazy Drizzle client — only constructed once, only when DATABASE_URL
// is set. Keeping this module-scoped means hot-reload reuses the pool.
let _db: PostgresJsDatabase | null = null;

function getDb(): PostgresJsDatabase | null {
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

function toEntry(row: typeof controlActions.$inferSelect): ActionEntry {
  return {
    timestamp: row.occurredAt.toISOString(),
    display_time: row.occurredAt.toTimeString().slice(0, 5),
    type: row.type as ActionType,
    title: row.title,
    reason: row.reason,
    ok: row.ok,
  };
}

export async function appendAction(entry: AppendAction): Promise<ActionEntry> {
  const now = new Date();
  const record: ActionEntry = {
    timestamp: now.toISOString(),
    display_time: now.toTimeString().slice(0, 5),
    ...entry,
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
