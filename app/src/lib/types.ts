// Helios API contract — shape drives both backend and PWA. Mirrors the
// validated prototype/data.js. When real integrations land, the provider
// adapters return this shape so the UI stays untouched.

export type TouPeriod = "off-peak" | "mid-peak" | "peak";
export type GridDirection = "idle" | "import" | "export";

export type EnergySnapshot = {
  /** Self-sufficiency %, 0–100. North-star metric. */
  self_sufficiency: number;
  /** Human-readable status word — "Optimized", "Charging", "Alert". */
  status_word: string;

  /** Instantaneous power flows in watts. */
  solar_w: number;
  home_w: number;
  ev_w: number;
  /** Powerwall power, watts. Positive = discharging (battery providing
   *  power to home/grid), negative = charging (power flowing into the
   *  battery). Matches Tesla's `battery_power` convention exactly. */
  pw_w: number;
  /** Grid: +ve import, -ve export. */
  grid_w: number;
  grid_direction: GridDirection;

  ev_soc: number;
  ev_target: number;
  ev_range: number;
  /** True when the EV is actively drawing current — reflects the
   *  charger's contactor / current measurement. False when the car is
   *  plugged in but idle (charge complete, manually paused, etc.) AND
   *  when unplugged. Pair with `ev_plugged_in` to disambiguate. */
  ev_charging: boolean;
  /** True when the cable is connected to the car, regardless of whether
   *  current is flowing. Required for the EV decision engine to gate
   *  correctly: stopped-but-plugged should still re-evaluate every
   *  tick, while unplugged should hold. */
  ev_plugged_in: boolean;
  ev_source: { solar: number; grid: number; battery?: number };
  /** Total kWh delivered to the EV since PT midnight today. Integrated
   *  Riemann-style from the energy_snapshots table. 0 when no charging
   *  has occurred yet today (or DB unavailable). */
  ev_charged_today_kwh: number;

  pw_soc: number;
  pw_reserve: number;
  pw_mode: string;

  tou_period: TouPeriod;
  tou_rate: number;
  /** PG&E NBT (NEM 3.0) export-credit rate active right now in $/kWh.
   *  Stamped from config at status-assembly time so the dashboard can
   *  render direction-aware rate chips ("EXPORTING · $0.04/kWh") without
   *  pulling /api/config separately. Currently a flat year-round rate;
   *  refining to hourly ACC values would change the source of this
   *  value, not its shape on the wire. */
  nem_export_rate: number;
  /** Today's NET grid cost in USD. Integrated from energy_snapshots:
   *  imports priced at per-snapshot TOU rate, exports priced at the
   *  flat NEM 3.0 export rate (config.nem_export_rate_per_kwh).
   *  NEGATIVE values mean "more credit than spend" — the dashboard
   *  renders these in green. Note: NEM 3.0 credits offset future
   *  imports at annual true-up; they are NOT cash. */
  daily_cost: number;
  /** Rolling 7-day net grid cost. Same shape as daily_cost. */
  week_cost: number;
  /** Rolling 30-day net grid cost. Same shape as daily_cost. */
  month_cost: number;
  /** Today's gross export kWh. Used by the Cost card to attribute the
   *  credit portion of the net cost separately from imports. */
  daily_export_kwh: number;
  /** @deprecated Was a counterfactual "saved vs naive charging" estimate
   *  but we never had a defensible naive model — removed from the UI in
   *  favor of real cost numbers. Kept on the type as optional to avoid
   *  breaking historical rows in the DB; new snapshots leave it unset. */
  daily_savings?: number;
};

export type SystemConfig = {
  location: string;
  utility: string;
  /** Home coordinates — required by Rivian charging schedules to
   *  geofence "is the car at home" before applying. Precision should
   *  be street-level (~50 m). */
  coords?: { lat: number; lng: number };
  solar: { model: string; count: number; peak: number };
  battery: { count: number; capacity: number; total: number; model: string };
  vehicle: { model: string; capacity: number; max_charge: number };
};

export type SnapshotSource =
  | "mock"
  | "enphase"
  | "tesla"
  | "smartcar"
  | "wall-connector"
  | "rivian";

/** Per-domain freshness state. The provider tag tells you WHO owns this
 *  field; the status tells you whether the value in the snapshot is
 *  actually from them this tick.
 *
 *   - "live"        — a configured provider successfully overlaid this
 *                     domain's fields. The number is fresh.
 *   - "unavailable" — a configured provider was attempted but the call
 *                     threw (timeout, OAuth lapse, rate limit, etc.).
 *                     The value sitting in the snapshot is the prior
 *                     mock seed and MUST NOT be trusted by engine or UI.
 *   - "mock"        — no provider was configured for this domain (or
 *                     assembly never reached the overlay). The mock
 *                     seed is showing through. Same trust level as
 *                     "unavailable" — both mean "not real data."
 *
 *  The distinction between "unavailable" and "mock" exists so logs and
 *  the dashboard can tell apart "you haven't connected Tesla yet" from
 *  "Tesla broke just now." Engine gates treat both as not-live. */
export type ProviderStatus = "live" | "unavailable" | "mock";

export type SourceInfo = {
  provider: SnapshotSource;
  status: ProviderStatus;
};

export type StatusResponse = {
  /** When the snapshot was produced (ISO 8601). */
  timestamp: string;
  snapshot: EnergySnapshot;
  system: SystemConfig;
  /** 24-hour solar production curve in kW, indexed by hour 0–23. */
  solar_curve: number[];
  /** 24-hour home consumption curve in kW. */
  home_curve: number[];
  /** Per-domain provenance + freshness. Required from assembleStatus()
   *  so consumers (cron gate, preview-decision, dashboard health pill)
   *  can never accidentally read undefined and treat all values as
   *  trusted by default. */
  sources: {
    solar: SourceInfo;
    home: SourceInfo;
    powerwall: SourceInfo;
    vehicle: SourceInfo;
  };
  /** Tags for derived-field compute paths that threw during assembly
   *  (self_sufficiency rollup, EV source split, cost integration,
   *  learned home curve, etc). Each tag means the corresponding field
   *  in `snapshot` is showing the mock seed value rather than today's
   *  computed result. The dashboard health pill aggregates this with
   *  `sources` to render a single trust signal; engine code does NOT
   *  read these (the rollup-derived fields are display-only). Empty
   *  list (or missing field) = clean assembly. */
  assembly_errors?: string[];
};

export type WeatherIcon = "sun" | "cloud-sun" | "cloud" | "rain";

export type ForecastHour = {
  /** Hour of day, 0–23. */
  hour: number;
  /** Expected solar production in kW. */
  solar: number;
  /** Cloud cover %, 0–100. */
  cloud: number;
  /** Temperature in °F. */
  temp: number;
};

export type ForecastDay = {
  day: string;
  kwh: number;
  icon: WeatherIcon;
  high: number;
  low: number;
  cloud: number;
  /** ISO timestamp of sunrise (with timezone offset). Optional — only
   *  populated when the upstream provides solar-time data. */
  sunrise?: string;
  /** ISO timestamp of sunset (with timezone offset). */
  sunset?: string;
};

export type ForecastResponse = {
  timestamp: string;
  hourly: ForecastHour[];
  daily: ForecastDay[];
};

export type ActionType = "reserve" | "charge" | "forecast" | "info" | "alert";

export type ActionEntry = {
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** HH:MM local display time, precomputed by backend. */
  display_time: string;
  type: ActionType;
  title: string;
  reason: string;
  ok: boolean;
  /** The value the action attempted to set. For reserve actions:
   *  the target reserve %. For charge actions: the desired rate in
   *  kW. Null for actions that don't naturally map (info, alert,
   *  forecast). */
  target_value?: number | null;
  /** The value before the action fired, for delta display in the UI
   *  (e.g. "20% → 55%"). Populated for reserve actions where prev
   *  reserve % is known; null elsewhere. */
  prev_value?: number | null;
};

export type ActionsResponse = {
  actions: ActionEntry[];
};

export type RatePeriod = {
  period: TouPeriod;
  from: string;
  to: string;
  rate: number;
};

export type RatesResponse = {
  utility: string;
  schedule: RatePeriod[];
};

// Operator-tunable policy for the decision engine. Lives in user_config.
export type ConfigResponse = {
  /** kW surplus required to start EV charging. */
  ev_charge_threshold_kw: number;
  /** kW hysteresis — keeps charging until surplus drops below
   *  (threshold - hysteresis) to prevent flapping. */
  ev_charge_hysteresis_kw: number;
  /** Reserve %, floor — never go below this during off-peak. */
  reserve_floor_pct: number;
  /** Reserve %, ceiling for peak-window guard. */
  reserve_peak_pct: number;
  /** Reserve %, ceiling for stormy forecast guard. */
  reserve_storm_pct: number;
  /** Daily kWh forecast below which "storm" guard kicks in. */
  storm_forecast_kwh: number;
  /** Minimum seconds between consecutive reserve writes. */
  min_action_interval_sec: number;

  // --- Sunset-aware EV charging policy (PRD addendum) ---
  /** PW SoC target at sunset−buffer. Empirically: 80% gets us through
   *  the night without grid import in Mill Valley. */
  pw_sunset_target_pct: number;
  /** EV SoC floor below which the off-peak grid backstop fires. */
  ev_min_pct: number;
  /** Hours before sunset at which we lock the EV cutoff. */
  sunset_buffer_hours: number;
  /** Days the car is parked at home and charging is possible.
   *  Indexed [Sun, Mon, Tue, Wed, Thu, Fri, Sat]. */
  parked_schedule: boolean[];
  /** Master toggle for the off-peak grid backstop. */
  backstop_enabled: boolean;
  /** ISO date (YYYY-MM-DD). When set and >= today's local date, the
   *  backstop is suppressed. Use to skip a single-day backstop. */
  backstop_disabled_until: string | null;
  /** Master pause switch. When false, the cron route still observes
   *  (writes snapshots, computes decisions) but does NOT actuate
   *  (no PW reserve writes, no Rivian start/stop). Use to take
   *  manual control without disconnecting any integration. */
  automation_enabled: boolean;
  /** EV SoC ceiling for the solar-boost branch. When ev_soc reaches or
   *  exceeds this value, the engine stops EV charging so remaining
   *  solar exports to grid (instead of overcharging the EV past the
   *  user's intent). Sits above the Rivian's own charge limit (typically
   *  80% for battery longevity) so the cap only matters when the user
   *  has lifted Rivian's limit to capture extra solar on a sunny day. */
  ev_solar_boost_cap_pct: number;
  /** Daily forecast threshold above which today is considered "high-
   *  energy" — used by the pre-departure relaxation on non-parked days
   *  to decide whether morning EV charging is justified. Paired with
   *  storm_forecast_kwh on the low side; the band between them is
   *  "neutral" (neither stormy nor surplus). */
  surplus_forecast_kwh: number;
  /** PW SoC floor below which the pre-departure EV charge is refused.
   *  When PW is this low in the morning, refilling PW takes priority
   *  over pre-charging the car — the existing "Today is not a parked
   *  day" hard-stop applies as before. */
  morning_pw_floor_pct: number;
  /** PG&E NBT (Net Billing Tariff) export-credit rate in $/kWh. NEM 3.0
   *  pays roughly this much per kWh exported. Used by the cost rollups
   *  to compute net cost = imports − exports × this. Real PG&E ACC
   *  values vary hour-by-hour ($0.02–$0.20 across the year); a flat
   *  $0.04 is a year-round average and a reasonable approximation
   *  until we wire the hourly ACC table. */
  nem_export_rate_per_kwh: number;
  /** Morning-bridge floor for PW reserve. When the engine detects an
   *  off-peak deficit during a sunny-day morning ramp (sun up, solar
   *  < home, forecast clear), it lowers the reserve target to this
   *  value so the Powerwall can cover the bridge until solar exceeds
   *  home demand. Lower than reserve_floor_pct = more aggressive
   *  bridging. Equal to reserve_floor_pct = no bridging (rule is
   *  effectively disabled). Default 10% leaves a small emergency
   *  cushion above Tesla's hardware floor. */
  morning_bridge_floor_pct: number;
};

// POST /api/reserve request body. Backend clamps to [0, 100].
export type ReserveRequest = {
  reserve_pct: number;
  reason?: string;
};

export type ReserveResponse = {
  ok: boolean;
  applied_pct: number;
  /** ISO 8601 timestamp of the executed action. */
  applied_at: string;
};
