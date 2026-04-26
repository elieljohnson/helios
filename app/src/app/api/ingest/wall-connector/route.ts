// Charger telemetry ingest. The home-side poller hits the Wall
// Connector's local /api/1/vitals every ~10s and POSTs the payload
// here. The server normalizes vendor fields into wallConnectorState
// and assembleStatus() reads the latest row.
//
// Auth: shared secret in Authorization: Bearer <HELIOS_INGEST_SECRET>.
// If the env var is unset (dev), accept any caller — same pattern as
// /api/cron/decide.
//
// The Zod schema is lenient: optional fields stay optional and unknown
// fields are preserved (passthrough → stored in raw JSONB). When Tesla
// firmware changes the shape, normalization keeps working as long as
// the few fields we actually compute on are present.
//
// POST body:
//   {
//     "vitals":   { /* full /api/1/vitals payload */ },
//     "lifetime": { /* full /api/1/lifetime payload, optional */ }
//   }
//
// Response: 204 on success, 4xx on validation/auth failure.

import { z } from "zod";
import { upsertSnapshot, type WallConnectorSnapshot } from "@/lib/wallconnector";

// Tesla Wall Connector vitals — lenient schema. Only fields the
// normalizer reads are validated; the rest are passed through and
// preserved in raw.
const vitalsSchema = z
  .object({
    contactor_closed: z.boolean().optional(),
    vehicle_connected: z.boolean().optional(),
    session_s: z.number().optional(),
    session_energy_wh: z.number().optional(),
    grid_v: z.number().optional(),
    vehicle_current_a: z.number().optional(),
    voltageA_v: z.number().optional(),
    voltageB_v: z.number().optional(),
    voltageC_v: z.number().optional(),
    evse_state: z.number().optional(),
  })
  .passthrough();

const lifetimeSchema = z
  .object({
    energy_wh: z.number().optional(),
  })
  .passthrough();

const ingestSchema = z.object({
  vitals: vitalsSchema,
  lifetime: lifetimeSchema.optional(),
});

/** Best-effort delivery voltage — prefers grid_v (line-to-line), falls
 *  back to the largest of the per-phase voltage readings. The Universal
 *  Wall Connector reports voltageB_v ≈ 234V on split-phase US installs;
 *  voltageA_v / voltageC_v are the two hot legs (~117V each). */
function deliveryVoltage(v: z.infer<typeof vitalsSchema>): number {
  if (typeof v.grid_v === "number" && v.grid_v > 100) return v.grid_v;
  const candidates = [v.voltageA_v, v.voltageB_v, v.voltageC_v].filter(
    (x): x is number => typeof x === "number",
  );
  if (candidates.length === 0) return 0;
  return Math.max(...candidates);
}

/** Normalize a Tesla vitals payload into the charger-agnostic shape. */
function normalize(payload: z.infer<typeof ingestSchema>): WallConnectorSnapshot {
  const v = payload.vitals;
  const current = typeof v.vehicle_current_a === "number" ? v.vehicle_current_a : 0;
  const volts = deliveryVoltage(v);
  const power_w = Math.round(current * volts);

  // is_charging: the contactor is closed AND there's actual current
  // flowing. Either alone is ambiguous — contactor can be closed
  // briefly during connect handshake without current, and current
  // briefly oscillates near zero between cells. The conjunction is
  // the unambiguous "engine on" signal.
  const is_charging =
    v.contactor_closed === true && current > 0.5;

  return {
    vehicle_connected: v.vehicle_connected ?? false,
    is_charging,
    power_w,
    session_energy_wh: Math.round(v.session_energy_wh ?? 0),
    session_seconds: Math.round(v.session_s ?? 0),
    lifetime_energy_wh:
      typeof payload.lifetime?.energy_wh === "number"
        ? Math.round(payload.lifetime.energy_wh)
        : undefined,
    voltage_v: volts || undefined,
    current_a: current || undefined,
    evse_state: typeof v.evse_state === "number" ? v.evse_state : undefined,
    ingested_at: new Date().toISOString(),
  };
}

export async function POST(request: Request) {
  // Shared-secret guard. Same Bearer pattern as /api/cron/decide.
  const expected = process.env.HELIOS_INGEST_SECRET;
  if (expected) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${expected}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = ingestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const snap = normalize(parsed.data);

  try {
    await upsertSnapshot(snap, parsed.data);
  } catch (err) {
    console.error("[ingest/wall-connector] upsert failed:", err);
    return Response.json({ error: "Persistence failed" }, { status: 500 });
  }

  return new Response(null, { status: 204 });
}

// Reject non-POST methods explicitly so misconfigured pollers (or a
// curious browser visit) get a clear error instead of a confusing 200.
export async function GET() {
  return Response.json(
    { error: "Method not allowed. POST telemetry payloads here." },
    { status: 405 },
  );
}
