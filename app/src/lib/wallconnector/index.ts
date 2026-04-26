// Wall Connector telemetry adapter.
//
// Singleton pattern: a home-side poller pushes the charger's latest
// state to /api/ingest/wall-connector, which calls upsertSnapshot()
// here. The status pipeline calls getWallConnectorSnapshot() and gets
// either a fresh row or null (stale/never-ingested).
//
// "Charger-agnostic by design" — the normalized shape is what Helios
// reasons about. The ingest endpoint translates vendor payloads
// (Tesla Wall Connector vitals today) into this shape. Adding a second
// charger source later is a new ingest route, not a schema change.

import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { wallConnectorState } from "@/db/schema";

/** A row is considered fresh if ingested within this window. Stale
 *  rows are treated as "poller is dead, charger telemetry offline" and
 *  the snapshot pipeline falls back to whatever earlier overlay
 *  supplied (Smartcar booleans, mock wattage). */
const MAX_AGE_SEC = 60;

export type WallConnectorSnapshot = {
  vehicle_connected: boolean;
  is_charging: boolean;
  /** Instantaneous draw in watts (V × A, derived ingest-side). */
  power_w: number;
  /** Energy delivered in the current session, watt-hours. */
  session_energy_wh: number;
  /** Seconds elapsed in current session (0 if not connected). */
  session_seconds: number;
  /** Lifetime energy delivered, watt-hours. Optional — not all
   *  payloads include it. */
  lifetime_energy_wh?: number;
  voltage_v?: number;
  current_a?: number;
  /** Vendor-specific state code, preserved for diagnostics. */
  evse_state?: number;
  /** ISO 8601 — when the poller observed the value. */
  ingested_at: string;
};

/** Memory fallback for environments without DATABASE_URL (tests, local
 *  dev). Single-row, mirrors the singleton DB pattern. */
let memoryRow: WallConnectorSnapshot | null = null;

/** Return the latest charger snapshot if it's fresh, else null. */
export async function getWallConnectorSnapshot(): Promise<WallConnectorSnapshot | null> {
  const db = getDb();
  let row: WallConnectorSnapshot | null;

  if (db) {
    const [r] = await db
      .select()
      .from(wallConnectorState)
      .where(eq(wallConnectorState.id, 1))
      .limit(1);
    if (!r) return null;
    row = {
      vehicle_connected: r.vehicleConnected,
      is_charging: r.isCharging,
      power_w: r.powerW,
      session_energy_wh: r.sessionEnergyWh,
      session_seconds: r.sessionSeconds,
      lifetime_energy_wh: r.lifetimeEnergyWh ?? undefined,
      voltage_v: r.voltageV ?? undefined,
      current_a: r.currentA ?? undefined,
      evse_state: r.evseState ?? undefined,
      ingested_at: r.ingestedAt.toISOString(),
    };
  } else {
    row = memoryRow;
  }

  if (!row) return null;
  const ageSec = (Date.now() - new Date(row.ingested_at).getTime()) / 1000;
  if (ageSec > MAX_AGE_SEC) return null;
  return row;
}

/** Upsert the singleton row. Called from the ingest endpoint. */
export async function upsertSnapshot(snap: WallConnectorSnapshot, raw: unknown): Promise<void> {
  const db = getDb();
  if (!db) {
    memoryRow = snap;
    return;
  }
  const ingestedAt = new Date(snap.ingested_at);
  await db
    .insert(wallConnectorState)
    .values({
      id: 1,
      vehicleConnected: snap.vehicle_connected,
      isCharging: snap.is_charging,
      powerW: snap.power_w,
      sessionEnergyWh: snap.session_energy_wh,
      sessionSeconds: snap.session_seconds,
      lifetimeEnergyWh: snap.lifetime_energy_wh ?? null,
      voltageV: snap.voltage_v ?? null,
      currentA: snap.current_a ?? null,
      evseState: snap.evse_state ?? null,
      raw: (raw ?? null) as Record<string, unknown> | null,
      ingestedAt,
    })
    .onConflictDoUpdate({
      target: wallConnectorState.id,
      set: {
        vehicleConnected: snap.vehicle_connected,
        isCharging: snap.is_charging,
        powerW: snap.power_w,
        sessionEnergyWh: snap.session_energy_wh,
        sessionSeconds: snap.session_seconds,
        lifetimeEnergyWh: snap.lifetime_energy_wh ?? null,
        voltageV: snap.voltage_v ?? null,
        currentA: snap.current_a ?? null,
        evseState: snap.evse_state ?? null,
        raw: (raw ?? null) as Record<string, unknown> | null,
        ingestedAt,
        updatedAt: new Date(),
      },
    });
}

/** Test-only: clear the memory fallback. */
export function _resetMemory(): void {
  memoryRow = null;
}
