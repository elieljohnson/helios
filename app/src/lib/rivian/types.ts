// Rivian unofficial API — TypeScript types.
//
// Source of truth for the GraphQL schema:
//   https://rivian-api.kaedenb.org/  (community-maintained)
//
// These types mirror the API responses we actually consume; we don't
// model the full schema (it's huge — vehicleState alone has ~100 fields).
// Add new fields as we need them.

/** Tokens returned by createCsrfToken mutation. Short-lived; used to
 *  authenticate subsequent login + API calls. */
export type RivianCsrfTokens = {
  csrfToken: string;
  appSessionToken: string;
};

/** Tokens returned by Login mutation, non-MFA branch (MobileLoginResponse). */
export type RivianLoginTokens = {
  accessToken: string;
  refreshToken: string;
  /** The session token passed as `u-sess` on every authenticated GraphQL
   *  call. Distinct from accessToken — Rivian's mobile app uses both
   *  alongside csrf-token + a-sess. */
  userSessionToken: string;
};

/** Login response when the account has 2FA enabled (MobileMFALoginResponse).
 *  We require non-MFA for now — Helios's UI is single-form, no OTP screen. */
export type RivianMfaChallenge = {
  otpToken: string;
};

export type RivianLoginResponse = RivianLoginTokens | RivianMfaChallenge;

/** Subset of the vehicle state response we use today. */
export type RivianVehicleStateField<T> = {
  __typename?: string;
  timeStamp: string;
  value: T;
};

export type RivianVehicleState = {
  /** SoC as a float percent (e.g. 59.4). Round/floor to int for display. */
  batteryLevel: RivianVehicleStateField<number>;
  /** Range in user units (mi or km — Rivian app picks based on user pref). */
  distanceToEmpty: RivianVehicleStateField<number>;
  /** "charging_active" | "charging_ready" | "charging_complete" |
   *  "charging_not_charging" | etc. Encoding shifts; treat as opaque. */
  chargerState: RivianVehicleStateField<string>;
  /** "chrgr_sts_connected_charging" | "chrgr_sts_not_connected" | etc. */
  chargerStatus: RivianVehicleStateField<string>;
};

/** Per-vehicle entry from currentUser.vehicles[]. */
export type RivianUserVehicle = {
  /** Internal vehicle UUID — what we pass to vehicleState(id: …). */
  id: string;
  vin: string;
  vehicle: {
    model: string;
    modelYear: number;
  };
};

export type RivianCurrentUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  vehicles: RivianUserVehicle[];
};

/** What Helios's status overlay reads. Mirrors lib/smartcar/index's
 *  EvSnapshot so the overlay code in status.ts stays uniform. */
export type RivianEvSnapshot = {
  /** Floor-int percent (0–100). */
  soc: number;
  /** Floor-int miles. */
  rangeMiles: number;
  /** Derived from chargerState — "charging_active" maps to true. */
  isCharging: boolean;
  /** True when the cable is plugged in regardless of charging activity. */
  isPluggedIn: boolean;
};

// ---- Charging schedule actuator -------------------------------------

export type RivianWeekDay =
  | "Monday"
  | "Tuesday"
  | "Wednesday"
  | "Thursday"
  | "Friday"
  | "Saturday"
  | "Sunday";

/** Input shape for setChargingSchedules mutation. Matches the InputChargingSchedule
 *  GraphQL type — see https://rivian-api.kaedenb.org/app/charging/charging-schedule/. */
export type RivianChargingSchedule = {
  /** Which days the schedule applies. For "charge now" we use just today. */
  weekDays: RivianWeekDay[];
  /** Minutes after midnight (local time). */
  startTime: number;
  /** Total schedule window in minutes. The car will charge UP TO the
   *  amperage limit during this window. */
  duration: number;
  /** Geofence — the schedule only applies when the car is at this
   *  location. Helios pulls from system.coords. */
  location: { latitude: number; longitude: number };
  /** Max current draw in amps. 240V split-phase × amps = watts. */
  amperage: number;
  /** False to disable the schedule without deleting it. We instead
   *  pass an empty array to setChargingSchedules to "stop now". */
  enabled: boolean;
};
