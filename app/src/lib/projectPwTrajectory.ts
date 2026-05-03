// Forward-looking energy-budget projection for the EV decision engine.
//
// Replaces the engine's previous instantaneous-surplus and rate-based
// trajectory checks with an integral budget that walks the rest of the
// day forward in hourly buckets and answers a single question:
//
//     "Is there a charging plan today where (a) the EV gains as much as
//      possible and (b) the Powerwall ends at-or-above its sunset
//      target?"
//
// Two branches:
//   - Parked-day:    car is here all day. Charge in parallel with PW
//                    recharge. The available-for-EV budget is leftover
//                    solar after house + PW catch-up.
//   - Driving-day:   car leaves at ~9:30 PT. Post-departure, the only
//                    absorber for solar is the Powerwall — and a full
//                    PW exports the surplus at NEM 3.0's $0.04/kWh
//                    (the loss this whole engine exists to avoid).
//                    The right move is to drain PW INTO the car BEFORE
//                    departure so PW has headroom to absorb the post-
//                    departure solar. The projection authorizes that
//                    drain only when the post-departure solar is
//                    forecast strong enough to refill PW to sunset
//                    target.
//
// Tariff-environment dependency (per app/AGENTS.md):
//   The whole projection assumes NEM 3.0 / NBT — exports pay a flat
//   ~$0.04/kWh ACC; imports cost $0.36–$0.58/kWh; peak-export arbitrage
//   does not exist. The "drain PW into car early" move pencils because
//   any kWh routed to the car displaces a future ~$0.40/kWh equivalent
//   (avoided gasoline) instead of being sold for $0.04 of credit.
//   Under NEM 2.0 (retail-rate exports), this calculus would be
//   approximately a wash and the parked-day branch would still hold,
//   but the driving-day pre-emptive-drain branch would not.
//   Invariant: import_rate >> export_rate.
//
// Sunset target is a HARD FLOOR, not a goal. When the forecast is too
// weak to support both filling the EV and ending PW above target, the
// engine prefers a partial EV charge (recommended via a lowered Rivian
// charge-limit %) over dropping PW below the floor.

import type { ForecastHour } from "./types";

/** 9:30 AM PT — average departure on driving days. Pulled out as a
 *  constant so a future settings field can override it without
 *  touching the projection logic. */
export const DEFAULT_DEPARTURE_HOUR_PT = 9.5;

/** Practical floor for residential L2 charging (6 A × 240 V ≈ 1.44 kW).
 *  Sustained EV draw below this either gets rejected by the car or
 *  oscillates between draw and idle. Mirrors the constant in
 *  decideEvCharge.ts. */
export const MIN_EV_RATE_KW = 1.5;

const TIMEZONE = "America/Los_Angeles";

export type ProjectPwInput = {
  /** Now. Defaults to new Date() at call sites; explicit here for tests. */
  now: Date;
  /** ISO sunset (with TZ offset). Required — caller has already
   *  short-circuited the past-cutoff case before calling. */
  sunsetIso: string;
  /** 24-element hourly forecast. Indexed by hour-of-day. solar in kW. */
  hourly: ForecastHour[];
  /** 24-element learned home-load curve in kW, indexed by hour-of-day. */
  home_curve: number[];

  // --- Powerwall state ---
  pw_soc_pct: number;
  pw_capacity_kwh: number;
  /** Sunset-target PW SoC, % of capacity. Hard floor. */
  pw_sunset_target_pct: number;

  // --- EV state ---
  ev_soc_pct: number;
  /** User's Rivian-set charge limit %. The car self-stops here. */
  ev_target_pct: number;
  ev_capacity_kwh: number;
  /** Car's max charge rate in kW. */
  ev_max_charge_kw: number;
  /** Live measured charging rate in kW (from Wall Connector ev_w/1000).
   *  0 when not charging. When > 0 we project at the live rate; when
   *  0 we project at ev_max_charge_kw as the planning estimate. */
  ev_live_charging_kw: number;

  // --- Schedule ---
  /** True when today is a parked-at-home day per parked_schedule. */
  todayParked: boolean;
  /** Departure hour PT for driving days. Default 9.5 (9:30 AM). */
  departureHourPT?: number;
};

export type ProjectPwResult = {
  /** Engine should authorize charging right now. */
  shouldStartNow: boolean;
  /** One-line summary for action log title. */
  reason: string;
  /** Step-by-step explanation. Joined by the engine into the action log. */
  reasoning: string[];
  /** Projected PW SoC % at sunset under the recommended plan. */
  projectedEndOfDayPwPct: number;
  /** Projected PW SoC % at departure (driving-day only). */
  projectedDeparturePwPct?: number;
  /** Recommended Rivian charge limit %. Telling the user this number
   *  lets the car self-stop at the right SoC — no second push needed. */
  evChargeLimitPct: number;
  /** Hours of charging required to reach evChargeLimitPct at the
   *  projected rate. */
  estimatedChargeHours: number;
  /** Per-hour rate in kW used for the recommendation. Either live
   *  measured (when actively charging) or ev_max_charge_kw (when not). */
  recommendedRateKw: number;
  /** Branch tag for downstream messaging. */
  mode: "parked" | "driving";
};

/**
 * Walk the rest of the day forward and find the best charging plan.
 *
 * Hourly accumulator pattern:
 *   - For the current bucket (the partial hour from `now` to the next
 *     hour boundary) we use only the fraction of the hour remaining.
 *   - For all subsequent buckets we use the full hour.
 *   - For the final bucket (sunset) we use only the fraction up to the
 *     sunset minute.
 *
 * Solar and house values are kW per ForecastHour and per-hour kW in
 * home_curve[h]; multiplied by the hour-fraction this gives kWh for
 * the bucket.
 */
export function projectPwTrajectory(input: ProjectPwInput): ProjectPwResult {
  const {
    now,
    sunsetIso,
    hourly,
    home_curve,
    pw_soc_pct,
    pw_capacity_kwh,
    pw_sunset_target_pct,
    ev_soc_pct,
    ev_target_pct,
    ev_capacity_kwh,
    ev_max_charge_kw,
    ev_live_charging_kw,
    todayParked,
  } = input;
  const departureHourPT =
    input.departureHourPT ?? DEFAULT_DEPARTURE_HOUR_PT;

  // Live rate when actively charging, planning estimate otherwise.
  // The Wall Connector's measured power is the truth source; the
  // car's `ev_max_charge_kw` is the manufacturer cap and only an
  // upper bound on what we'll actually see.
  const recommendedRateKw =
    ev_live_charging_kw > 0.1 ? ev_live_charging_kw : ev_max_charge_kw;

  const reasoning: string[] = [];
  const sunsetMs = new Date(sunsetIso).getTime();
  const nowMs = now.getTime();

  // Convert PW + EV state to kWh once.
  const pw_soc_kwh = (pw_soc_pct / 100) * pw_capacity_kwh;
  const pw_sunset_target_kwh =
    (pw_sunset_target_pct / 100) * pw_capacity_kwh;
  const ev_soc_kwh = (ev_soc_pct / 100) * ev_capacity_kwh;
  const ev_target_kwh = (ev_target_pct / 100) * ev_capacity_kwh;
  const ev_gap_kwh = Math.max(0, ev_target_kwh - ev_soc_kwh);

  if (todayParked) {
    return projectParked({
      reasoning,
      now,
      nowMs,
      sunsetMs,
      hourly,
      home_curve,
      pw_soc_kwh,
      pw_sunset_target_kwh,
      pw_capacity_kwh,
      ev_soc_pct,
      ev_target_pct,
      ev_capacity_kwh,
      ev_gap_kwh,
      recommendedRateKw,
    });
  }

  return projectDriving({
    reasoning,
    now,
    nowMs,
    sunsetMs,
    departureHourPT,
    hourly,
    home_curve,
    pw_soc_kwh,
    pw_sunset_target_kwh,
    pw_capacity_kwh,
    ev_soc_pct,
    ev_target_pct,
    ev_capacity_kwh,
    ev_gap_kwh,
    recommendedRateKw,
  });
}

// --- Parked branch --------------------------------------------------

type ParkedArgs = {
  reasoning: string[];
  now: Date;
  nowMs: number;
  sunsetMs: number;
  hourly: ForecastHour[];
  home_curve: number[];
  pw_soc_kwh: number;
  pw_sunset_target_kwh: number;
  pw_capacity_kwh: number;
  ev_soc_pct: number;
  ev_target_pct: number;
  ev_capacity_kwh: number;
  ev_gap_kwh: number;
  recommendedRateKw: number;
};

function projectParked(a: ParkedArgs): ProjectPwResult {
  const {
    reasoning,
    now,
    nowMs,
    sunsetMs,
    hourly,
    home_curve,
    pw_soc_kwh,
    pw_sunset_target_kwh,
    pw_capacity_kwh,
    ev_soc_pct,
    ev_target_pct,
    ev_capacity_kwh,
    ev_gap_kwh,
    recommendedRateKw,
  } = a;

  const { solarKwh, houseKwh } = integrateRange(
    hourly,
    home_curve,
    nowMs,
    sunsetMs,
  );

  const pw_gap_to_target_kwh = Math.max(
    0,
    pw_sunset_target_kwh - pw_soc_kwh,
  );
  const available_for_ev_kwh = +(
    solarKwh -
    houseKwh -
    pw_gap_to_target_kwh
  ).toFixed(2);

  reasoning.push(
    `Parked day. Solar remaining ${solarKwh.toFixed(1)} kWh, house ${houseKwh.toFixed(1)} kWh until sunset.`,
  );
  reasoning.push(
    `PW gap to sunset target: ${pw_gap_to_target_kwh.toFixed(1)} kWh.`,
  );
  reasoning.push(
    `Solar budget available for EV: ${available_for_ev_kwh.toFixed(1)} kWh.`,
  );

  if (available_for_ev_kwh <= 0) {
    return {
      shouldStartNow: false,
      reason: "Forecast too weak — protect Powerwall sunset target",
      reasoning: [
        ...reasoning,
        `Budget ≤ 0 — solar can't cover house + PW catch-up. ` +
          `Charging EV would force PW below sunset target.`,
      ],
      projectedEndOfDayPwPct:
        Math.max(0, pw_soc_kwh + solarKwh - houseKwh) /
        pw_capacity_kwh *
        100,
      evChargeLimitPct: ev_soc_pct,
      estimatedChargeHours: 0,
      recommendedRateKw,
      mode: "parked",
    };
  }

  // Cap the delivered amount by what the car can actually accept.
  const delivered_kwh = Math.min(available_for_ev_kwh, ev_gap_kwh);
  const final_ev_pct = +Math.min(
    ev_target_pct,
    ev_soc_pct + (delivered_kwh / ev_capacity_kwh) * 100,
  ).toFixed(0);
  const charge_hours = +(delivered_kwh / recommendedRateKw).toFixed(1);

  // Project the actual end-of-day PW SoC under this plan. When the
  // EV hits its Rivian limit before the day's solar budget is
  // exhausted, the leftover solar continues into PW *above* the
  // sunset target — capped at 100% (PW capacity), beyond which it
  // exports to grid at $0.04/kWh.
  //
  // Earlier versions hardcoded this to sunset_target_pct, which sold
  // the engine's plan short on every sunny day where the EV was
  // already nearly full. Observed 2026-05-03: pushed "PW projected
  // at 80% by sunset," reality was PW filled to 100% by mid-
  // afternoon with ~11 kWh exported.
  const ev_leftover_kwh = Math.max(0, available_for_ev_kwh - delivered_kwh);
  const pw_end_kwh = Math.min(
    pw_capacity_kwh,
    pw_sunset_target_kwh + ev_leftover_kwh,
  );
  const projected_end_pct = +(pw_end_kwh / pw_capacity_kwh * 100).toFixed(0);

  // No "minimum session length" check on parked days. The car draws
  // at full L2 regardless of any rate suggestion, so even a tiny
  // top-off (e.g. 1% / 1.35 kWh) charges for ~7 min and then stops
  // when it hits the user's set Rivian limit. That's still useful
  // and worth pushing. The engine's only gate here is "is there
  // any positive budget?" — already handled above.

  if (final_ev_pct < ev_target_pct) {
    reasoning.push(
      `Budget supports partial charge to ~${final_ev_pct}% ` +
        `(short of ${ev_target_pct}% Rivian limit). Sunset target wins.`,
    );
  } else {
    reasoning.push(
      `Budget supports full charge to ${final_ev_pct}% in ~${charge_hours} h.`,
    );
  }

  return {
    shouldStartNow: true,
    reason:
      final_ev_pct < ev_target_pct
        ? `Charge to ~${final_ev_pct}% (forecast-limited)`
        : `Charge to ${final_ev_pct}%`,
    reasoning,
    projectedEndOfDayPwPct: projected_end_pct,
    evChargeLimitPct: final_ev_pct,
    estimatedChargeHours: charge_hours,
    recommendedRateKw,
    mode: "parked",
  };
}

// --- Driving branch -------------------------------------------------

type DrivingArgs = ParkedArgs & {
  departureHourPT: number;
};

function projectDriving(a: DrivingArgs): ProjectPwResult {
  const {
    reasoning,
    now,
    nowMs,
    sunsetMs,
    departureHourPT,
    hourly,
    home_curve,
    pw_soc_kwh,
    pw_sunset_target_kwh,
    pw_capacity_kwh,
    ev_soc_pct,
    ev_target_pct,
    ev_capacity_kwh,
    ev_gap_kwh,
    recommendedRateKw,
  } = a;

  // Departure timestamp in the current PT day.
  const departureMs = ptHourToMs(now, departureHourPT);

  // If we're already past departure, the car has either left (cable
  // disconnected, gate 1 caught it) or never went out. Treat as a
  // parked-day projection from this point — same math, no drain
  // optimization.
  if (nowMs >= departureMs) {
    return projectParked({ ...a });
  }

  const hours_to_departure = (departureMs - nowMs) / 3_600_000;

  // Pre-departure window: now → departure.
  const pre = integrateRange(hourly, home_curve, nowMs, departureMs);
  // Post-departure window: departure → sunset. This is the absorption
  // pressure on PW after the car leaves.
  const post = integrateRange(hourly, home_curve, departureMs, sunsetMs);

  const surplus_post_dep_kwh = Math.max(0, post.solarKwh - post.houseKwh);
  // What PW must be at, at most, by departure for it to end at sunset
  // target. If post-dep surplus exceeds the gap from zero to target,
  // the floor is 0 — PW can be empty at departure and still recover.
  const pw_target_at_departure_kwh = Math.max(
    0,
    pw_sunset_target_kwh - surplus_post_dep_kwh,
  );
  // How much we can drain PW into the car before departure.
  const pw_drain_room_kwh = Math.max(
    0,
    pw_soc_kwh - pw_target_at_departure_kwh,
  );
  // Pre-departure surplus from solar (whatever solar exceeds the
  // house's pre-dep load).
  const solar_remaining_pre_dep_kwh = Math.max(
    0,
    pre.solarKwh - pre.houseKwh,
  );

  // Total energy available to push into the car before departure.
  const total_available_kwh =
    pw_drain_room_kwh + solar_remaining_pre_dep_kwh;
  // Physical rate cap: car can't accept more than rate × time.
  const rate_capped_kwh = recommendedRateKw * hours_to_departure;
  // Car-side cap: don't overcharge past the EV gap.
  const delivered_kwh = +Math.min(
    total_available_kwh,
    rate_capped_kwh,
    ev_gap_kwh,
  ).toFixed(2);

  reasoning.push(
    `Driving day. ${hours_to_departure.toFixed(1)} h until ${formatHourPT(departureHourPT)} PT departure.`,
  );
  reasoning.push(
    `Post-departure surplus solar: ${surplus_post_dep_kwh.toFixed(1)} kWh ` +
      `(solar ${post.solarKwh.toFixed(1)} − house ${post.houseKwh.toFixed(1)}).`,
  );
  reasoning.push(
    `PW target at departure: ${(pw_target_at_departure_kwh / pw_capacity_kwh * 100).toFixed(0)}% — ` +
      `room to drain ${pw_drain_room_kwh.toFixed(1)} kWh into car now.`,
  );
  reasoning.push(
    `Pre-departure solar surplus: ${solar_remaining_pre_dep_kwh.toFixed(1)} kWh.`,
  );
  reasoning.push(
    `Available for EV: ${total_available_kwh.toFixed(1)} kWh ` +
      `(rate-capped at ${rate_capped_kwh.toFixed(1)} kWh; ` +
      `car-capped at ${ev_gap_kwh.toFixed(1)} kWh).`,
  );

  // Sustained-rate sanity: if delivered amount over the time window
  // can't sustain at least the L2 floor, the schedule won't take.
  const sustained_rate_kw = delivered_kwh / hours_to_departure;
  if (sustained_rate_kw < MIN_EV_RATE_KW) {
    const projected_end_pct = +(
      Math.max(
        0,
        pw_soc_kwh + pre.solarKwh - pre.houseKwh + surplus_post_dep_kwh,
      ) /
      pw_capacity_kwh *
      100
    ).toFixed(0);
    return {
      shouldStartNow: false,
      reason: "Forecast too weak to support driving-day pre-charge",
      reasoning: [
        ...reasoning,
        `Sustained rate ${sustained_rate_kw.toFixed(2)} kW < ${MIN_EV_RATE_KW} kW L2 floor.`,
      ],
      projectedEndOfDayPwPct: projected_end_pct,
      projectedDeparturePwPct: +(
        Math.max(0, pw_soc_kwh + pre.solarKwh - pre.houseKwh) /
        pw_capacity_kwh *
        100
      ).toFixed(0),
      evChargeLimitPct: ev_soc_pct,
      estimatedChargeHours: 0,
      recommendedRateKw,
      mode: "driving",
    };
  }

  const final_ev_pct = +Math.min(
    ev_target_pct,
    ev_soc_pct + (delivered_kwh / ev_capacity_kwh) * 100,
  ).toFixed(0);

  // Project PW SoC at departure under the chosen plan. Energy
  // balance: pw_soc + (pre-dep solar) − (pre-dep house) − (kWh sent
  // to car). Negative values floor at 0.
  const pw_at_departure_kwh = Math.max(
    0,
    pw_soc_kwh + pre.solarKwh - pre.houseKwh - delivered_kwh,
  );
  const projected_departure_pct = +(
    pw_at_departure_kwh / pw_capacity_kwh *
    100
  ).toFixed(0);

  // End-of-day projection: pw_at_departure + post-dep surplus, capped
  // at PW capacity.
  const pw_end_kwh = Math.min(
    pw_capacity_kwh,
    pw_at_departure_kwh + surplus_post_dep_kwh,
  );
  const projected_end_pct = +(pw_end_kwh / pw_capacity_kwh * 100).toFixed(0);

  reasoning.push(
    `Plan: charge to ${final_ev_pct}%. PW drops to ` +
      `${projected_departure_pct}% by departure, refills to ${projected_end_pct}% by sunset.`,
  );

  return {
    shouldStartNow: true,
    reason:
      final_ev_pct < ev_target_pct
        ? `Driving day — charge to ~${final_ev_pct}% (forecast-limited)`
        : `Driving day — charge to ${final_ev_pct}%`,
    reasoning,
    projectedEndOfDayPwPct: projected_end_pct,
    projectedDeparturePwPct: projected_departure_pct,
    evChargeLimitPct: final_ev_pct,
    estimatedChargeHours: +(delivered_kwh / recommendedRateKw).toFixed(1),
    recommendedRateKw,
    mode: "driving",
  };
}

// --- Helpers --------------------------------------------------------

/** Sum solar (kWh) and house (kWh) over [startMs, endMs] using
 *  hour-fractional weighting at the boundaries. */
function integrateRange(
  hourly: ForecastHour[],
  home_curve: number[],
  startMs: number,
  endMs: number,
): { solarKwh: number; houseKwh: number } {
  if (endMs <= startMs) return { solarKwh: 0, houseKwh: 0 };

  let solarKwh = 0;
  let houseKwh = 0;

  // Walk hour-by-hour. For each bucket, compute the fraction of that
  // hour overlapped by [startMs, endMs] and weight solar/house by it.
  // We work in PT hours-of-day (0–23), tracked by walking ms forward.
  let cursor = startMs;
  while (cursor < endMs) {
    const cursorHour = ptHour(new Date(cursor));
    const cursorDate = new Date(cursor);
    // ms at the next hour boundary in PT.
    const nextBoundary = ptNextHourMs(cursorDate);
    const segmentEnd = Math.min(nextBoundary, endMs);
    const fraction = (segmentEnd - cursor) / 3_600_000;
    const solarKw = hourly[cursorHour]?.solar ?? 0;
    const homeKw = home_curve[cursorHour] ?? 1.0;
    solarKwh += solarKw * fraction;
    houseKwh += homeKw * fraction;
    cursor = segmentEnd;
  }
  return { solarKwh, houseKwh };
}

/** Hour 0–23 in America/Los_Angeles for the given absolute moment. */
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

/** ms at the next PT hour boundary after `d`. E.g. at 09:23 PT, returns
 *  the ms for 10:00 PT today. */
function ptNextHourMs(d: Date): number {
  const minute = parseInt(
    new Intl.DateTimeFormat("en-US", {
      minute: "2-digit",
      timeZone: TIMEZONE,
    }).format(d),
    10,
  );
  const second = parseInt(
    new Intl.DateTimeFormat("en-US", {
      second: "2-digit",
      timeZone: TIMEZONE,
    }).format(d),
    10,
  );
  return d.getTime() + (60 - minute) * 60_000 - second * 1000;
}

/** Convert a PT hour-of-day (e.g. 9.5 = 9:30) to an absolute ms in the
 *  same PT calendar day as `now`. */
function ptHourToMs(now: Date, hourPT: number): number {
  // Build a local ISO for "today PT at hourPT". We rely on the fact
  // that en-CA emits ISO dates in YYYY-MM-DD.
  const ymd = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: TIMEZONE,
  }).format(now);
  const hh = Math.floor(hourPT);
  const mm = Math.round((hourPT - hh) * 60);
  // PT offset: derive from now to handle PST/PDT.
  const offsetMin = ptOffsetMinutes(now);
  const sign = offsetMin <= 0 ? "-" : "+";
  const absMin = Math.abs(offsetMin);
  const offH = String(Math.floor(absMin / 60)).padStart(2, "0");
  const offM = String(absMin % 60).padStart(2, "0");
  const iso = `${ymd}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00${sign}${offH}:${offM}`;
  return new Date(iso).getTime();
}

/** Minutes offset from UTC for America/Los_Angeles at the given moment.
 *  Negative for PST/PDT (west of UTC). E.g. PDT returns -420. */
function ptOffsetMinutes(d: Date): number {
  // Use the locale string trick: format `d` in PT and in UTC, diff.
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
      .formatToParts(d)
      .reduce<Record<string, string>>((acc, p) => {
        if (p.type !== "literal") acc[p.type] = p.value;
        return acc;
      }, {});
  const parts = fmt(TIMEZONE);
  const utc = fmt("UTC");
  const ptMs = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour % 24,
    +parts.minute,
    +parts.second,
  );
  const utcMs = Date.UTC(
    +utc.year,
    +utc.month - 1,
    +utc.day,
    +utc.hour % 24,
    +utc.minute,
    +utc.second,
  );
  return Math.round((ptMs - utcMs) / 60_000);
}

function formatHourPT(hourPT: number): string {
  const h = Math.floor(hourPT);
  const m = Math.round((hourPT - h) * 60);
  const hh12 = h % 12 === 0 ? 12 : h % 12;
  const ampm = h < 12 ? "AM" : "PM";
  return `${hh12}:${String(m).padStart(2, "0")} ${ampm}`;
}
