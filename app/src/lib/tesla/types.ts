// Subset of Tesla Fleet API responses we consume. The Fleet API is the
// official OAuth-2 replacement for the deprecated owner-api. Public docs:
// https://developer.tesla.com/docs/fleet-api

export type TeslaTokenResponse = {
  access_token: string;
  refresh_token: string;
  /** Seconds until access_token expiry (typically 28800 = 8h). */
  expires_in: number;
  token_type: "Bearer";
  id_token?: string;
  scope?: string;
};

/** Single product entry from /api/1/products. */
export type TeslaProduct = {
  /** Energy site only — e.g. "energy_site_id" 1234567890. */
  energy_site_id?: number;
  /** Vehicle only. Not consumed for Helios. */
  vehicle_id?: number;
  resource_type: "battery" | "solar" | "vehicle" | "wall_connector";
  site_name?: string;
  id?: string;
  /** Powerwall-specific identifier, present on energy_site rows. */
  energy_left?: number;
  total_pack_energy?: number;
  percentage_charged?: number;
  battery_power?: number;
};

export type TeslaProductsResponse = {
  response: TeslaProduct[];
  count: number;
};

/** Per-charger state nested inside TeslaLiveStatus.wall_connectors[].
 *  Tesla surfaces the residential Wall Connector's live state in the
 *  same energy-site live_status call we already make for the Powerwall,
 *  so reading it adds zero API requests / rate-limit cost. */
export type TeslaWallConnectorState = {
  /** Tesla device identification number, "1734412-02-E--<serial>". */
  din: string;
  /** Plugged-in vehicle VIN. Empty string for non-Tesla vehicles
   *  (e.g. a Rivian charging on a Universal Wall Connector — Tesla's
   *  cloud sees a session but can't identify the car). */
  vin: string;
  /** Tesla's charger state encoding. Empirically:
   *    1 = idle / booting
   *    2 = vehicle connected, not charging
   *    4 = charging or recently charged
   *  Encoding shifts across firmware versions, so prefer
   *  wall_connector_power as the authoritative charging signal. */
  wall_connector_state: number;
  /** Fault code; 0 = healthy, 2 = also observed during normal idle. */
  wall_connector_fault_state?: number;
  /** Power in kW. Positive = delivering to vehicle. Idle reads
   *  ≈ -0.01 kW (measurement noise around zero). */
  wall_connector_power: number;
  ocpp_status?: number;
  powershare_session_state?: number;
};

/** /api/1/energy_sites/{site_id}/live_status — the heart of the Powerwall
 *  overlay. Single source for solar, load, battery, grid, SoC, reserve.
 *  Powers in watts (positive = into the home, negative = out of the home,
 *  per Tesla's convention). */
export type TeslaLiveStatus = {
  /** Instantaneous solar production in W. */
  solar_power: number;
  /** Instantaneous home load in W (sign: positive = consumption). */
  load_power: number;
  /** Powerwall power in W. Positive = charging, negative = discharging. */
  battery_power: number;
  /** Grid power in W. Positive = importing, negative = exporting. */
  grid_power: number;
  /** Battery state-of-charge in percent (0–100). */
  percentage_charged: number;
  /** Backup reserve target in percent (0–100). The actuator setpoint. */
  backup_reserve_percent?: number;
  /** Site operational mode — "self_consumption" | "backup" | "autonomous". */
  default_real_mode?: string;
  /** "Solar" | "Storm Watch" | "Backup" — surfaced in mobile app. */
  storm_mode_active?: boolean;
  total_pack_energy?: number;
  energy_left?: number;
  island_status?: "on_grid" | "off_grid" | "off_grid_intentional";
  /** Residential Wall Connectors linked to this energy site. Inline so
   *  one live_status call covers both Powerwall and EV charger state. */
  wall_connectors?: TeslaWallConnectorState[];
  /** ISO 8601. */
  timestamp: string;
};

export type TeslaLiveStatusResponse = {
  response: TeslaLiveStatus;
};

/** /api/1/energy_sites/{id}/site_info — static-ish config. */
export type TeslaSiteInfo = {
  id: string;
  site_name: string;
  backup_reserve_percent: number;
  default_real_mode: string;
  installation_date: string;
  components: {
    solar: boolean;
    battery: boolean;
    grid: boolean;
    backup: boolean;
    gateway: string;
    load_meter: boolean;
    tou_capable: boolean;
    storm_mode_capable: boolean;
    flex_energy_request_capable: boolean;
    car_charging_data_supported: boolean;
    off_grid_vehicle_charging_reserve_supported: boolean;
    vehicle_charging_performance_view_enabled: boolean;
    vehicle_charging_solar_offset_view_enabled: boolean;
    battery_solar_offset_view_enabled: boolean;
    energy_value_header: string;
    energy_value_subheader: string;
    show_grid_import_battery_source_cards: boolean;
    set_islanding_mode_enabled: boolean;
    wifi_commissioning_enabled: boolean;
    backup_time_remaining_enabled: boolean;
    rate_plan_manager_supported: boolean;
    battery_type: string;
    configurable: boolean;
    grid_services_enabled: boolean;
  };
};

export type TeslaSiteInfoResponse = {
  response: TeslaSiteInfo;
};

export type TeslaPartnerAccountResponse = {
  response: {
    domain: string;
    name?: string;
    description?: string;
    client_id?: string;
    public_key?: string;
  };
};
