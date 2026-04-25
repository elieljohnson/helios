// Sunset-aware EV charging engine. Pure function — same shape as decide().
// Caller is responsible for actuation (Rivian app/API) and action logging.
//
// Goal: never pay PG&E for grid imports. Under NEM 3.0 the import/export
// asymmetry (~$0.58/kWh peak import vs. ~$0.04/kWh export) means surplus
// solar should always go to on-site loads (EV or PW) before export.
//
// Rules (PRD addendum):
//   1. Past sunset−buffer: stop the EV. Protect overnight PW headroom.
//      Exception: off-peak grid backstop if EV is critically low and
//      tomorrow's solar is also weak.
//   2. Before sunset−buffer: charge the EV with the solar budget left
//      after reserving enough to land PW at pw_sunset_target_pct by
//      the cutoff. Empirically: 80% PW at sunset−1h gets through the
//      night without grid import in Mill Valley.
//
// budget_kwh = solar_remaining − home_remaining − pw_gap_kwh
// rate_kw    = clamp(budget_kwh / hours_to_cutoff, 0, ev_max_charge_kw)

import type {
  ConfigResponse,
  EnergySnapshot,
  ForecastResponse,
  SystemConfig,
} from "./types";

const TIMEZONE = "America/Los_Angeles";

export type EvDecision = {
  /** What the actuator should do.
   *   - "start" → start charging at desired_rate_kw (or full rate if undefined)
   *   - "stop"  → halt charging
   *   - "hold"  → no decision applies (e.g., car not plugged in) */
  action: "start" | "stop" | "hold";
  /** One-line summary for action log titles. */
  reason: string;
  /** Step-by-step explanation, ordered. Mirrors decide()'s reasoning chain. */
  reasoning: string[];
  /** Solar surplus left for the car after reserving PW headroom, in kWh. */
  budget_kwh?: number;
  /** Recommended charging rate in kW. */
  desired_rate_kw?: number;
};

export type DecideEvInput = {
  snapshot: EnergySnapshot;
  system: SystemConfig;
  config: ConfigResponse;
  forecast: ForecastResponse;
  /** 24h home consumption curve in kW, indexed by local hour 0..23. */
  home_curve: number[];
  /** Injectable for tests. Defaults to new Date(). */
  now?: Date;
};

export function decideEvCharge(input: DecideEvInput): EvDecision {
  const { snapshot, system, config, forecast, home_curve } = input;
  const now = input.now ?? new Date();
  const reasoning: string[] = [];

  // Gate 1: car must be plugged in. ev_charging is the live signal.
  if (!snapshot.ev_charging) {
    return {
      action: "hold",
      reason: "Car not plugged in",
      reasoning: ["Car not plugged in — no EV decision."],
    };
  }

  const sunsetIso = forecast.daily[0]?.sunset;
  if (!sunsetIso) {
    return {
      action: "hold",
      reason: "Forecast missing sunset",
      reasoning: ["No sunset in forecast — defer."],
    };
  }

  const sunsetMs = new Date(sunsetIso).getTime();
  const cutoffMs = sunsetMs - config.sunset_buffer_hours * 3_600_000;
  const cutoffHour = ptHour(new Date(cutoffMs));
  const sunsetHour = ptHour(new Date(sunsetMs));
  reasoning.push(
    `Sunset ${sunsetHour}:00 PT; cutoff ${cutoffHour}:00 PT (sunset − ${config.sunset_buffer_hours}h).`,
  );

  // --- Past cutoff: protect overnight headroom ---
  if (now.getTime() >= cutoffMs) {
    return decidePastCutoff({ snapshot, config, forecast, now, reasoning });
  }

  // --- Before cutoff: Rule 2 budget ---
  const currentHour = ptHour(now);
  // Sum hourly solar + home from now's hour through (and including) cutoffHour.
  let solarRemaining = 0;
  let homeRemaining = 0;
  for (let h = currentHour; h <= cutoffHour; h++) {
    solarRemaining += forecast.hourly[h]?.solar ?? 0;
    homeRemaining += home_curve[h] ?? 1.0;
  }
  solarRemaining = +solarRemaining.toFixed(2);
  homeRemaining = +homeRemaining.toFixed(2);

  const pwGapPct = config.pw_sunset_target_pct - snapshot.pw_soc;
  const pwGapKwh = +((pwGapPct / 100) * system.battery.total).toFixed(2);
  const budget = +(solarRemaining - homeRemaining - pwGapKwh).toFixed(2);

  reasoning.push(
    `Solar remaining ${solarRemaining} kWh, home ~${homeRemaining} kWh until cutoff.`,
  );
  reasoning.push(
    `PW gap to ${config.pw_sunset_target_pct}%: ${pwGapKwh} kWh (current ${snapshot.pw_soc}%).`,
  );
  reasoning.push(`EV budget: ${budget} kWh.`);

  if (budget <= 0) {
    return {
      action: "stop",
      reason: "No solar budget for car after PW protection",
      reasoning: [
        ...reasoning,
        `Budget ≤ 0 — stop car so solar can refill PW to ${config.pw_sunset_target_pct}%.`,
      ],
      budget_kwh: budget,
    };
  }

  const hoursToCutoff = +(
    (cutoffMs - now.getTime()) / 3_600_000
  ).toFixed(2);
  const desiredRateKw = +Math.min(
    Math.max(0, budget / Math.max(hoursToCutoff, 0.1)),
    system.vehicle.max_charge,
  ).toFixed(2);

  return {
    action: "start",
    reason: "Solar budget available — charge car",
    reasoning: [
      ...reasoning,
      `Charge at ${desiredRateKw} kW (budget ${budget} kWh / ${hoursToCutoff}h, capped at ${system.vehicle.max_charge} kW).`,
    ],
    budget_kwh: budget,
    desired_rate_kw: desiredRateKw,
  };
}

type PastCutoffInput = {
  snapshot: EnergySnapshot;
  config: ConfigResponse;
  forecast: ForecastResponse;
  now: Date;
  reasoning: string[];
};

function decidePastCutoff(input: PastCutoffInput): EvDecision {
  const { snapshot, config, forecast, now, reasoning } = input;
  reasoning.push(`Past cutoff — protect overnight PW headroom.`);

  const backstopActive = isBackstopActive(config, now);
  const evCriticallyLow = snapshot.ev_soc < config.ev_min_pct;
  const tomorrowKwh = forecast.daily[1]?.kwh ?? Infinity;
  const tomorrowLow = tomorrowKwh < config.storm_forecast_kwh;
  const offPeak = snapshot.tou_period === "off-peak";

  if (backstopActive && evCriticallyLow && tomorrowLow && offPeak) {
    return {
      action: "start",
      reason: "Off-peak backstop — EV critically low, tomorrow's solar weak",
      reasoning: [
        ...reasoning,
        `EV ${snapshot.ev_soc}% < min ${config.ev_min_pct}%; tomorrow ${tomorrowKwh} kWh < ${config.storm_forecast_kwh} kWh.`,
        `Off-peak — accept grid charge to floor.`,
      ],
    };
  }

  // Build a single-line diagnostic so the log captures why the backstop
  // didn't fire, even when the answer is just "everything is fine."
  const why: string[] = [];
  if (!backstopActive) why.push("backstop disabled");
  if (!evCriticallyLow) why.push(`EV ${snapshot.ev_soc}% ≥ ${config.ev_min_pct}%`);
  if (!tomorrowLow) why.push(`tomorrow ${tomorrowKwh} kWh ≥ ${config.storm_forecast_kwh}`);
  if (!offPeak) why.push(`TOU ${snapshot.tou_period}`);

  return {
    action: "stop",
    reason: "Sunset cutoff — protect PW for overnight",
    reasoning: [
      ...reasoning,
      `Backstop conditions not met (${why.join("; ")}).`,
      `Stop car until next morning.`,
    ],
  };
}

function isBackstopActive(config: ConfigResponse, now: Date): boolean {
  if (!config.backstop_enabled) return false;
  if (config.backstop_disabled_until) {
    // disabled_until is a YYYY-MM-DD local date. The override applies
    // for the entirety of that local day.
    if (ptDate(now) <= config.backstop_disabled_until) return false;
  }
  return true;
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

/** YYYY-MM-DD in America/Los_Angeles. en-CA emits ISO date format natively. */
function ptDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: TIMEZONE,
  }).format(d);
}
