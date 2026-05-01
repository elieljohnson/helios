// Subset of Smartcar V3 vehicle API return shapes we consume. Smartcar
// normalizes across brands so the same shape works for Rivian R1T,
// Tesla, Ford, etc.

export type SmartcarBattery = {
  /** State of charge as a 0..1 fraction (Smartcar's convention). */
  percentRemaining: number;
  /** Estimated range in km or mi depending on unit system; Helios is mi. */
  range: number;
  meta?: { dataAge?: string; requestId?: string; unitSystem?: string };
};

export type SmartcarCharge = {
  /** Whether the charging cable is connected. */
  isPluggedIn: boolean;
  /** "CHARGING" | "FULLY_CHARGED" | "NOT_CHARGING" */
  state: "CHARGING" | "FULLY_CHARGED" | "NOT_CHARGING";
  meta?: { dataAge?: string; requestId?: string };
};

export type SmartcarVehicleInfo = {
  id: string;
  make: string;
  model: string;
  year: number;
  meta?: { requestId?: string };
};

/** Aggregate snapshot the cron + status assembler use. Hides Smartcar's
 *  per-call meta + units behind a Helios-shaped object. */
export type SmartcarEvSnapshot = {
  vehicleId: string;
  make: string;
  model: string;
  /** SoC as a 0..100 integer percent. */
  soc: number;
  /** Range in miles, integer. */
  rangeMiles: number;
  isPluggedIn: boolean;
  isCharging: boolean;
};

// ---- V3 signals API shapes ------------------------------------------
//
// The V3 vehicle-data endpoint at GET /v3/vehicles/{id}/signals returns
// a JSON:API-shaped array of signal envelopes. The envelope is uniform;
// the inner `body` is signal-specific. We model the envelope and a
// best-effort union of the body shapes for the signals Helios reads.
//
// Important V3 quirk: a signal may have `status.value === "ERROR"` and
// still return a body with the last-known cached value. Treat ERROR as
// "couldn't refresh from OEM, but here's the cache" rather than a hard
// failure. Discovered empirically via scripts/discover-smartcar-signals.ts.

export type SmartcarV3Signal<TBody = unknown> = {
  /** Kebab-case signal code, e.g. "tractionbattery-stateofcharge". */
  id: string;
  type: "signal";
  attributes: {
    code: string;
    name: string;
    group: string;
    status: { value: "SUCCESS" | "ERROR" | string };
    body?: TBody;
  };
  meta?: { retrievedAt?: number; oemUpdatedAt?: number };
  links?: { self?: string };
};

export type SmartcarV3SignalsResponse = {
  data: SmartcarV3Signal[];
};

/** Body shapes for the specific signals Helios consumes today. */
export type V3StateOfChargeBody = { value: number; unit?: "percent" };
export type V3RangeBody = { value: number; unit?: "km" | "mi"; type?: string };
export type V3IsChargingBody = { value: boolean };
export type V3IsCableConnectedBody = { value: boolean };
export type V3ChargeLimitsBody = {
  values?: Array<{ type: string; limit: number }>;
  activeLimit?: number;
  unit?: "percent";
};

/** Charge-limit GET response. The limit is a 0..1 fraction (NOT
 *  percent) — Smartcar's documented convention. Multiply by 100 for
 *  display; convert back to fraction-as-string for setChargeLimit. */
export type SmartcarChargeLimit = {
  limit: number;
  meta?: { requestId?: string };
};

