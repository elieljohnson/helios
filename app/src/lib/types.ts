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
  /** Powerwall: +ve charging, -ve discharging. */
  pw_w: number;
  /** Grid: +ve import, -ve export. */
  grid_w: number;
  grid_direction: GridDirection;

  ev_soc: number;
  ev_target: number;
  ev_range: number;
  ev_charging: boolean;
  ev_source: { solar: number; grid: number; battery?: number };

  pw_soc: number;
  pw_reserve: number;
  pw_mode: string;

  tou_period: TouPeriod;
  tou_rate: number;
  daily_cost: number;
  daily_savings: number;
};

export type SystemConfig = {
  location: string;
  utility: string;
  solar: { model: string; count: number; peak: number };
  battery: { count: number; capacity: number; total: number; model: string };
  vehicle: { model: string; capacity: number; max_charge: number };
  powerwalls: { id: string; soc: number; health: number }[];
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
