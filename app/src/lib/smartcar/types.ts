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
