import { z } from "zod";

// Request schemas — single source of truth for API validation.
// Response shapes still live in types.ts because they're derived from
// the backend/provider adapters, not from user input.

export const reserveRequestSchema = z.object({
  reserve_pct: z.number().min(0).max(100),
  reason: z.string().max(280).optional(),
});

// Partial config update for POST /api/config. Every field optional —
// the Settings UI sends only what changed. Server merges into the
// existing row.
export const configUpdateSchema = z.object({
  ev_charge_threshold_kw: z.number().min(0).max(20).optional(),
  ev_charge_hysteresis_kw: z.number().min(0).max(5).optional(),
  reserve_floor_pct: z.number().min(0).max(100).optional(),
  reserve_peak_pct: z.number().min(0).max(100).optional(),
  reserve_storm_pct: z.number().min(0).max(100).optional(),
  storm_forecast_kwh: z.number().min(0).max(200).optional(),
  min_action_interval_sec: z.number().int().min(60).max(3600).optional(),

  pw_sunset_target_pct: z.number().min(0).max(100).optional(),
  ev_min_pct: z.number().min(0).max(100).optional(),
  sunset_buffer_hours: z.number().min(0).max(6).optional(),
  parked_schedule: z.array(z.boolean()).length(7).optional(),
  backstop_enabled: z.boolean().optional(),
  backstop_disabled_until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
    .nullable()
    .optional(),
  automation_enabled: z.boolean().optional(),
  ev_solar_boost_cap_pct: z.number().min(0).max(100).optional(),
  surplus_forecast_kwh: z.number().min(0).max(200).optional(),
  morning_pw_floor_pct: z.number().min(0).max(100).optional(),
  // Year-round PG&E ACC averages ~$0.04; daytime peaks ~$0.20; cap at
  // $1 to leave headroom without inviting nonsense values.
  nem_export_rate_per_kwh: z.number().min(0).max(1).optional(),
  // Lower bound 0 (no cushion at all) is permitted but not advised;
  // upper bound matches reserve_floor_pct's max so the bridge can be
  // disabled by setting equal to floor.
  morning_bridge_floor_pct: z.number().min(0).max(100).optional(),
});
