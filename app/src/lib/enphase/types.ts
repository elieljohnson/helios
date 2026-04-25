// Subset of Enphase Enlighten v4 response shapes that we actually use.
// Full schema: https://developer-v4.enphase.com/docs

export type EnphaseTokenResponse = {
  access_token: string;
  refresh_token: string;
  /** Seconds until access_token expiry (typically 86400 = 24h). */
  expires_in: number;
  token_type: "bearer";
  scope?: string;
  /** Enphase system_id tied to the homeowner who authorized. */
  enl_uid?: string;
  enl_cid?: string;
};

export type EnphaseSystem = {
  system_id: number;
  name: string;
  public_name: string;
  timezone: string;
  /** kW peak / DC capacity. */
  size_w?: number;
  status: string;
  last_report_at?: number;
};

export type EnphaseSystemsResponse = {
  systems: EnphaseSystem[];
  total: number;
  current_page: number;
  size: number;
};

export type EnphaseTelemetryInterval = {
  /** Unix seconds — the closing edge of the interval. */
  end_at: number;
  devices_reporting: number;
  /** Energy across the interval in watt-hours (always present). */
  enwh?: number;
  /** Average power across the interval in watts (sometimes present;
   *  varies by Enphase deployment). */
  powr?: number;
};

export type EnphaseTelemetryResponse = {
  system_id: number;
  granularity: "15mins" | "day" | "week";
  total_devices: number;
  start_at: number;
  end_at: number;
  items: string;
  intervals: EnphaseTelemetryInterval[];
  meta?: {
    status: string;
    last_report_at: number;
    last_energy_at: number;
    operational_at: number;
  };
};

export type EnphaseSummary = {
  system_id: number;
  /** Current AC power production in W. Null when no data. */
  current_power: number;
  /** Today's energy production in Wh. */
  energy_today: number;
  /** Lifetime energy production in Wh. */
  energy_lifetime: number;
  /** Module count (panels). */
  modules: number;
  /** Wh per second from the most recent 5-min reporting interval. */
  source: string;
  status: "normal" | "power" | "comm" | "meter" | string;
  /** Unix seconds. */
  last_report_at: number;
  /** Unix seconds (start of summary day). */
  summary_date: string;
  /** Operational mode. */
  operational_at?: number;
  size_w?: number;
};
