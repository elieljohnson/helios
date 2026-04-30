// Pure transform: V3 signals array → SmartcarEvSnapshot.
//
// The V3 read endpoint returns 20+ signals per vehicle in one call.
// This file picks out the five Helios consumes (SoC, range, charging
// state, plug state, vehicle info) and projects them onto the existing
// SmartcarEvSnapshot shape so consumers (status.ts, cron) don't change.
//
// V3-specific behaviors handled here:
//
//   1. Signals frequently arrive with status="ERROR" but a non-null
//      body containing the last cached OEM value. Helios treats body
//      as best-effort — read it if present, surface a missing-field
//      sentinel only when body itself is absent. This matches the
//      project's "use what's there, surface staleness via source tags"
//      pattern from production-data discipline (app/AGENTS.md).
//
//   2. V3 returns range in km. Helios is US-units throughout
//      (status.ts, UI cards, history rollups all assume miles). One
//      conversion at this seam keeps the rest of the codebase
//      unit-stable.
//
//   3. V3 SoC is already 0..100 integer percent. V2 was 0..1 float.
//      Direct read, no multiply.
//
// Pure function; unit-tested in transform.test.ts. No network, no DB.

import type {
  SmartcarEvSnapshot,
  SmartcarV3Signal,
  V3IsCableConnectedBody,
  V3IsChargingBody,
  V3RangeBody,
  V3StateOfChargeBody,
} from "./types";

/** Vehicle metadata isn't part of the signals payload; the caller
 *  fetches it once (from /v3/vehicles/{id}) and passes it in. */
export type VehicleInfo = {
  vehicleId: string;
  make: string;
  model: string;
};

/** km → mi. 1 km = 0.621371 mi. */
const KM_PER_MI = 1.609344;

/** Build a code→signal map for O(1) lookups. With 20 signals it's a
 *  readability choice more than a perf one. */
function index(signals: SmartcarV3Signal[]): Map<string, SmartcarV3Signal> {
  return new Map(signals.map((s) => [s.attributes.code, s]));
}

/** Read a signal's body if the signal exists. Treats status="ERROR"
 *  with a non-null body as best-effort cached value, not a failure. */
function bodyOf<T>(
  map: Map<string, SmartcarV3Signal>,
  code: string,
): T | undefined {
  const sig = map.get(code);
  if (!sig) return undefined;
  return sig.attributes.body as T | undefined;
}

/** Project the V3 signal array onto Helios's shape. Returns a complete
 *  SmartcarEvSnapshot if the four core signals (SoC, range, isCharging,
 *  cable-connected) all have body values; null otherwise.
 *
 *  Choosing null-on-incomplete over partial-snapshot: Helios's consumers
 *  (status.ts overlay, cron decision engine) read these fields without
 *  null-checking each one. Returning a partial would silently leak
 *  zero/undefined into downstream computations, the exact pattern the
 *  4/29 mock-data incident punished. Better to return null here and let
 *  the source-status plumbing mark Smartcar as unavailable. */
export function signalsToEvSnapshot(opts: {
  signals: SmartcarV3Signal[];
  info: VehicleInfo;
}): SmartcarEvSnapshot | null {
  const m = index(opts.signals);

  const socBody = bodyOf<V3StateOfChargeBody>(m, "tractionbattery-stateofcharge");
  const rangeBody = bodyOf<V3RangeBody>(m, "tractionbattery-range");
  const isChargingBody = bodyOf<V3IsChargingBody>(m, "charge-ischarging");
  const cableBody = bodyOf<V3IsCableConnectedBody>(m, "charge-ischargingcableconnected");

  if (
    socBody?.value == null ||
    rangeBody?.value == null ||
    isChargingBody?.value == null ||
    cableBody?.value == null
  ) {
    return null;
  }

  const rangeMiles =
    rangeBody.unit === "mi"
      ? Math.round(rangeBody.value)
      : Math.round(rangeBody.value / KM_PER_MI);

  return {
    vehicleId: opts.info.vehicleId,
    make: opts.info.make,
    model: opts.info.model,
    soc: Math.round(socBody.value),
    rangeMiles,
    isCharging: isChargingBody.value === true,
    isPluggedIn: cableBody.value === true,
  };
}
