// Home geofence helpers. Used by the Gate 1c guard in decideEvCharge
// to refuse charging recommendations when the car is physically away
// from home — regardless of whatever the plug-state field happens to
// say on this tick.
//
// Layered with Layer 1 (two-consecutive-ticks plug-state guard) and
// the structural sources-status fix that AGENTS.md recommends. The
// geofence is the most robust of the three because it ground-truths
// against physical reality (the car's GPS) rather than against
// vendor reporting hygiene.

/** Earth's mean radius in meters. Standard WGS84-ish constant —
 *  good to ~0.5% over the small distances we care about (sub-km
 *  geofence). */
const EARTH_RADIUS_M = 6_371_000;

/** Maximum age of a GNSS reading we'll trust for geofencing.
 *  Vehicles in deep sleep can keep returning the same lat/lng for
 *  hours — fine if the car hasn't moved, but we don't want to
 *  authorize charging based on yesterday's parked-at-home reading
 *  when the car drove away last night.
 *
 *  10 minutes balances "fresh enough to be ground truth" against
 *  "the car woke up briefly an hour ago." On a real charging session
 *  the car is awake and reports new GNSS every minute. */
export const MAX_LOCATION_AGE_SEC = 10 * 60;

export type Coords = { lat: number; lng: number };

/**
 * Distance in meters between two GPS coordinates using the Haversine
 * formula. Accurate to ~0.5% over short distances; well within the
 * tens-of-meters we care about for geofencing.
 *
 * Reference: https://en.wikipedia.org/wiki/Haversine_formula
 */
export function haversineMeters(a: Coords, b: Coords): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_M * c;
}

export type GeofenceVerdict =
  | { state: "at_home"; distanceM: number }
  | { state: "away"; distanceM: number }
  | { state: "unknown"; reason: string };

/**
 * Classify the car's current position relative to home.
 *
 * Returns:
 *   - { state: "at_home", distanceM } — car is within radiusM of home,
 *     and the GPS reading is fresh.
 *   - { state: "away",    distanceM } — car is outside radiusM AND
 *     reading is fresh. Engine should refuse charging recommendations.
 *   - { state: "unknown", reason }    — no usable location data
 *     (location absent, stale, or home coords missing). Engine falls
 *     back to plug state alone — geofence is inert.
 */
export function classifyGeofence(opts: {
  carLat?: number;
  carLng?: number;
  carLocationAtIso?: string;
  homeLat?: number;
  homeLng?: number;
  radiusM: number;
  /** Injectable for tests. Defaults to new Date(). */
  now?: Date;
}): GeofenceVerdict {
  const {
    carLat,
    carLng,
    carLocationAtIso,
    homeLat,
    homeLng,
    radiusM,
  } = opts;
  const now = opts.now ?? new Date();

  if (typeof homeLat !== "number" || typeof homeLng !== "number") {
    return { state: "unknown", reason: "home coordinates not configured" };
  }
  if (typeof carLat !== "number" || typeof carLng !== "number") {
    return { state: "unknown", reason: "vehicle GPS unavailable" };
  }
  if (carLocationAtIso) {
    const ageSec = (now.getTime() - new Date(carLocationAtIso).getTime()) / 1000;
    if (ageSec > MAX_LOCATION_AGE_SEC) {
      return {
        state: "unknown",
        reason: `vehicle GPS stale (${Math.round(ageSec / 60)} min old)`,
      };
    }
  }

  const distanceM = haversineMeters(
    { lat: carLat, lng: carLng },
    { lat: homeLat, lng: homeLng },
  );
  return distanceM <= radiusM
    ? { state: "at_home", distanceM }
    : { state: "away", distanceM };
}
