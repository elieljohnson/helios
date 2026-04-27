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
  /** Today's grid-import cost in USD. Integrated from energy_snapshots
   *  with the per-snapshot TOU rate applied. Imports only — does not
   *  net out NEM 3.0 export credits (would need NBT hourly table). */
  daily_cost: number;
  /** Rolling 7-day grid-import cost in USD. Same shape as daily_cost. */
  week_cost: number;
  /** Rolling 30-day grid-import cost in USD. Same shape as daily_cost. */
  month_cost: number;
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
  powerwalls: { id: string; soc: number; health: number }[];
};

export type SnapshotSource =
  | "mock"
  | "enphase"
  | "tesla"
  | "smartcar"
  | "wall-connector"
  | "rivian";

export type StatusResponse = {
  /** When the snapshot was produced (ISO 8601). */
  timestamp: string;
  snapshot: EnergySnapshot;
  system: SystemConfig;
  /** 24-hour solar production curve in kW, indexed by hour 0–23. */
  solar_curve: number[];
  /** 24-hour home consumption curve in kW. */
  home_curve: number[];
  /** Per-domain provenance — which fields are live vs. mocked. Optional
   *  because the field is only populated by assembleStatus(). */
  sources?: {
    solar: SnapshotSource;
    home: SnapshotSource;
    powerwall: SnapshotSource;
    vehicle: SnapshotSource;
  };
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
