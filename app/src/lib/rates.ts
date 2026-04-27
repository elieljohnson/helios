// PG&E E-TOU-C rate schedule.
//
// E-TOU-C is the "Time-of-Use 4–9 PM" plan PG&E offers for residential
// customers. Two periods, year-round, no seasonal split:
//   - Peak:     16:00–21:00 PT (4 PM – 9 PM, every day)
//   - Off-peak: all other hours
//
// Rates are approximate Q1 2026 values; actual PG&E tariffs adjust
// quarterly. Lift to `system.rates.{peak,off_peak}` config when we
// support multiple utilities or plan variants.
//
// Why we hardcode the schedule rather than pulling from PG&E's API:
// PG&E doesn't expose tariff data publicly, and the E-TOU-C window is
// so simple (one peak block, fixed hours, no holidays) that a 5-line
// lookup beats a 200-line OAuth-and-cache layer.

const TIMEZONE = "America/Los_Angeles";
const PEAK_START_HOUR = 16; // 4 PM PT
const PEAK_END_HOUR = 21; //   9 PM PT

/** $/kWh imported during the peak window. */
export const PEAK_RATE = 0.58;
/** $/kWh imported outside the peak window. */
export const OFF_PEAK_RATE = 0.36;

export type TouPeriod = "peak" | "off-peak";

export type RateInfo = {
  period: TouPeriod;
  rate: number;
};

/** Hour 0–23 in PT for an absolute moment. Mirrors lib/decideEvCharge.ts's
 *  ptHour() — duplicated here to avoid a cross-module dep on a private
 *  helper. If we add a third use site, lift to a shared lib/time.ts. */
function ptHour(d: Date): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hour12: false,
      timeZone: TIMEZONE,
    }).format(d),
    10,
  );
}

/** TOU period and rate active at the given moment, in PT. */
export function getRateAt(d: Date): RateInfo {
  const h = ptHour(d);
  const isPeak = h >= PEAK_START_HOUR && h < PEAK_END_HOUR;
  return isPeak
    ? { period: "peak", rate: PEAK_RATE }
    : { period: "off-peak", rate: OFF_PEAK_RATE };
}

export type NextTransition = {
  /** Hour in PT when the next period starts (16 or 21). */
  atHourPt: number;
  /** Display string like "16:00" — caller can render directly. */
  display: string;
  /** What period the rate flips to. */
  toPeriod: TouPeriod;
  /** What the rate becomes after the transition. */
  toRate: number;
};

/** When the rate changes next, in PT. Wraps midnight cleanly: a query
 *  at 22:00 returns "16:00 → peak" because that's the next transition,
 *  even though it's tomorrow. */
export function getNextTransition(d: Date): NextTransition {
  const h = ptHour(d);
  if (h < PEAK_START_HOUR) {
    return {
      atHourPt: PEAK_START_HOUR,
      display: "16:00",
      toPeriod: "peak",
      toRate: PEAK_RATE,
    };
  }
  if (h < PEAK_END_HOUR) {
    return {
      atHourPt: PEAK_END_HOUR,
      display: "21:00",
      toPeriod: "off-peak",
      toRate: OFF_PEAK_RATE,
    };
  }
  // After 21:00 — next transition is tomorrow at 16:00.
  return {
    atHourPt: PEAK_START_HOUR,
    display: "16:00",
    toPeriod: "peak",
    toRate: PEAK_RATE,
  };
}
