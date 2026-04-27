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
};
