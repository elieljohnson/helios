// Sunset-aware EV charging engine. Pure function — same shape as decide().
// Caller is responsible for actuation (Rivian app/API) and action logging.
//
// Goal: never pay PG&E for grid imports. Under NEM 3.0 the import/export
// asymmetry (~$0.58/kWh peak import vs. ~$0.04/kWh export) means surplus
// solar should always go to on-site loads (EV or PW) before export.
//
// Strict waterfall (user-stated policy):
//
//   Tier 1 — PW < pw_sunset_target_pct (default 80%):
//             Stop EV. Solar fills PW first.
//   Tier 2 — PW ≥ target AND EV < cap (Rivian limit, default 80%):
//             Charge EV at instantaneous solar surplus.
//   Tier 3 — PW ≥ target AND EV ≥ cap:
//             Stop EV. Solar tops PW from target → 100% naturally
//             (PW absorbs anything not consumed by house/EV).
//   Tier 4 — PW = 100% AND EV ≥ cap:
//             Solar exports to grid (engine takes no action; no actuator
//             change is needed for export).
//
// Past-cutoff/backstop rules unchanged. The waterfall replaces the
// older "trajectory check + budget spread" mode that allowed parallel
// PW + EV charging based on forecast — simpler mental model, slightly
// more conservative (EV waits for PW to hit target before starting).

import type {
  ConfigResponse,
  EnergySnapshot,
  ForecastResponse,
  SystemConfig,
} from "./types";

const TIMEZONE = "America/Los_Angeles";

/** parked_schedule index → display name. Schema is [Sun, Mon, ..., Sat]. */
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

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
  /** @deprecated Was the kWh budget under the old budget-spread mode.
   *  No longer computed under the strict waterfall (the engine just
   *  routes instantaneous surplus). Kept on the type so historical
   *  callers don't break — always undefined now. */
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
  const { snapshot, system, config, forecast } = input;
  const now = input.now ?? new Date();
  const reasoning: string[] = [];

  // Gate 1: car must be plugged in. Use the explicit plug state so
  // the engine keeps re-evaluating when the car is connected but
  // idle (charge complete, manually paused, or stopped by a previous
  // engine tick). Conflating ev_charging with plug state used to
  // lock the engine after every stop — the cable status is the
  // correct gate.
  if (!snapshot.ev_plugged_in) {
    return {
      action: "hold",
      reason: "Car not plugged in",
      reasoning: ["Cable not connected — no EV decision until plugged in."],
    };
  }

  // Gate 2: today must be a parked-at-home day. parked_schedule is the
  // user's stated policy ("Charging is only possible on parked days"
  // per the Settings UI). If the schedule says the car shouldn't be
  // home today, hard-stop charging — even if the cable is connected,
  // we don't want to run the EV against the user's policy.
  // schema: parked_schedule[0]=Sun ... parked_schedule[6]=Sat.
  const todayDow = ptDow(now);
  const todayParked = config.parked_schedule?.[todayDow] ?? true;
  if (!todayParked) {
    return {
      action: "stop",
      reason: "Today is not a parked day",
      reasoning: [
        `${DAY_NAMES[todayDow]} marked as away in parked schedule — charging disabled.`,
      ],
    };
  }

  // Gate 3: EV at-or-above its target SoC. Two stop conditions, lower
  // wins:
  //   - snapshot.ev_target — Rivian's own charge limit, set in the
  //     Rivian app (default 80% for NMC battery longevity). Source of
  //     truth for "the user's intended SoC ceiling for this car."
  //   - config.ev_solar_boost_cap_pct — Helios-side override. Default
  //     100 (no effect); user can lower to enforce a stricter ceiling
  //     than whatever Rivian is currently set to.
  // When the lower of these two is reached, the engine stops the EV so
  // remaining solar surplus flows to the PW (until 100%) and then to
  // the grid — Tier 3 / Tier 4 of the waterfall. This is also the
  // signal that lets the PW top off from target → 100% naturally.
  const evCap = Math.min(
    snapshot.ev_target ?? 100,
    config.ev_solar_boost_cap_pct,
  );
  if (snapshot.ev_soc >= evCap) {
    return {
      action: "stop",
      reason: `EV at ${snapshot.ev_soc}% — at charge limit (${evCap}%)`,
      reasoning: [
        `EV SoC ${snapshot.ev_soc}% ≥ ${evCap}% (` +
          `Rivian limit ${snapshot.ev_target ?? "—"}, ` +
          `Helios cap ${config.ev_solar_boost_cap_pct}). ` +
          `Stop EV — solar now tops PW to 100%, then exports.`,
      ],
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

  // --- Tier 1: PW must be at target before EV gets any solar ---
  // Strict waterfall: solar fills PW to pw_sunset_target_pct first,
  // then EV, then PW from target → 100%. No trajectory check —
  // simpler than the previous "is PW on track" model, at the cost of
  // some early-day EV charging that could've started while PW was
  // still climbing on track.
  if (snapshot.pw_soc < config.pw_sunset_target_pct) {
    reasoning.push(
      `PW ${snapshot.pw_soc}% < target ${config.pw_sunset_target_pct}% — ` +
        `Tier 1, refill PW before EV.`,
    );
    return {
      action: "stop",
      reason: "Powerwall below target — refill PW before EV",
      reasoning: [
        ...reasoning,
        `Strict waterfall — solar feeds PW until it hits ` +
          `${config.pw_sunset_target_pct}%; EV resumes after.`,
      ],
    };
  }

  // --- Tier 2: PW at/above target, EV under its limit ---
  // Use INSTANTANEOUS surplus for the rate — every watt of headroom
  // (solar minus house base) flows to the car at the current solar
  // level. Cron re-fires every 5 min, so the schedule tracks real-time
  // conditions without an explicit ramp loop.
  //
  // home_w from Tesla's load_power INCLUDES the EV draw, so we
  // subtract ev_w to get "house only" — the correct value to deduct
  // from solar when computing the EV's available headroom.
  const houseW = Math.max(0, snapshot.home_w - snapshot.ev_w);
  const surplusKw = Math.max(0, (snapshot.solar_w - houseW) / 1000);
  const desiredRateKw = +Math.min(
    surplusKw,
    system.vehicle.max_charge,
  ).toFixed(2);
  reasoning.push(
    `Tier 2 — PW at ${snapshot.pw_soc}% (≥ target). ` +
      `Surplus ${surplusKw.toFixed(2)} kW ` +
      `(solar ${(snapshot.solar_w / 1000).toFixed(1)} − ` +
      `house ${(houseW / 1000).toFixed(1)}).`,
  );

  // Minimum-rate gate: 6A × 240V ≈ 1.44 kW is the practical floor for
  // residential L2 charging — below that the car either rejects the
  // schedule outright or oscillates between draw and idle. Stop instead
  // of pushing a sub-minimum rate that the actuator chain can't honor.
  const MIN_EV_RATE_KW = 1.5;
  if (desiredRateKw < MIN_EV_RATE_KW) {
    return {
      action: "stop",
      reason: "Solar surplus too low for minimum charge rate",
      reasoning: [
        ...reasoning,
        `Desired ${desiredRateKw} kW < min ${MIN_EV_RATE_KW} kW (6A × 240V floor).`,
      ],
    };
  }

  return {
    action: "start",
    reason: "Solar surplus available — charge car",
    reasoning,
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

/** Day of week in PT (0=Sun ... 6=Sat). Matches the parked_schedule
 *  index convention. Date#getDay() returns the local-machine day,
 *  which would be UTC on Vercel — wrong for our purposes. */
function ptDow(d: Date): number {
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    timeZone: TIMEZONE,
  }).format(d);
  const idx = DAY_NAMES.indexOf(weekday as (typeof DAY_NAMES)[number]);
  // Defensive default: Intl can return long-form variants on some
  // locales/runtimes; if anything's off, fall back to "parked" by
  // treating today as Sun (the user's most-likely-parked default).
  return idx >= 0 ? idx : 0;
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
