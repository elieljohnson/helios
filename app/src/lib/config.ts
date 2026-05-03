import type { ConfigResponse } from "./types";

// Default policy. Will be overridden by user_config row once DB is wired.
// Values tuned per PRD §4 (decision engine). Keep in one place so the
// decision engine, the config endpoint, and future admin UI all agree.
export const DEFAULT_CONFIG: ConfigResponse = {
  ev_charge_threshold_kw: 2.0,
  ev_charge_hysteresis_kw: 0.5,
  reserve_floor_pct: 20,
  reserve_peak_pct: 60,
  reserve_storm_pct: 80,
  storm_forecast_kwh: 15,
  min_action_interval_sec: 300,

  // Sunset-aware EV charging defaults. Tuned for the reference system
  // (Mill Valley + 3× Powerwall + Rivian R1T on PG&E E-TOU-C).
  pw_sunset_target_pct: 80,
  ev_min_pct: 30,
  sunset_buffer_hours: 1,
  // [Sun, Mon, Tue, Wed, Thu, Fri, Sat] — car at home Mon/Fri/weekends.
  parked_schedule: [true, true, false, false, false, true, true],
  backstop_enabled: true,
  backstop_disabled_until: null,
  automation_enabled: true,
  // 100% — Helios-side override on top of the Rivian's own charge limit.
  // The engine stops EV charging at min(snapshot.ev_target, this value),
  // so default 100 means "respect whatever the Rivian app is set to."
  // Lower this to enforce a stricter ceiling than Rivian's setting (e.g.,
  // user wants Rivian-90 on road-trip days but Helios-80 normally).
  ev_solar_boost_cap_pct: 100,
  // Pre-departure charge gate. On a non-parked day the engine normally
  // hard-stops the EV; these two relax that to allow morning charging
  // when both conditions are true. Defaults: 40 kWh forecast (clearly
  // above storm_forecast_kwh=15 to avoid overlap), 20% PW floor (matches
  // reserve_floor_pct).
  surplus_forecast_kwh: 40,
  morning_pw_floor_pct: 20,
  // PG&E NBT (NEM 3.0) export-credit rate. $0.04/kWh is a flat-rate
  // approximation of the year-round average ACC value; hourly ACC
  // refinement is a separate task that won't change this shape.
  nem_export_rate_per_kwh: 0.04,
  // Morning-bridge floor. See types.ts comment for the full rationale.
  // 10% leaves Tesla's hardware floor + small emergency cushion.
  morning_bridge_floor_pct: 10,
  // EV projection's forecast-error hedge. The integral projection
  // reserves enough PW catch-up to land at (sunset_target + this)
  // instead of exactly at sunset_target. 5% ≈ 2 kWh on a 40.5 kWh
  // PW — small enough not to refuse charging on most days, large
  // enough to cover modest forecast slip (the kind we saw 2026-05-03
  // with the marine layer).
  pw_sunset_safety_margin_pct: 5,
};
