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

/** parked_schedule index → display name. Schema is [Sun, Mon, ..., Sat]. */
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Minimum-rate floor: 6A × 240V ≈ 1.44 kW is the practical floor for
 *  residential L2 charging — below that the car either rejects the
 *  schedule outright or oscillates between draw and idle. */
const MIN_EV_RATE_KW = 1.5;

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

  // Gate 2: today must be a parked-at-home day, OR (relaxation) the
  // car is plugged in during a pre-departure morning window AND the
  // forecast says we have surplus solar to spare.
  //
  // Why the relaxation: on non-parked days the car leaves mid-morning.
  // Solar that hits after the cable disconnects either fills PW (until
  // 100%) or exports to grid at NEM ~$0.04/kWh. On high-forecast days
  // that's wasted energy — PW will fill from solar regardless. Better
  // to capture early morning surplus in the EV battery for a future
  // drive.
  //
  // Both conditions must hold to relax:
  //   1. forecast.daily[0].kwh ≥ surplus_forecast_kwh — today is
  //      forecast as a "high-energy" day (PW will fill anyway).
  //   2. snapshot.pw_soc ≥ morning_pw_floor_pct — PW isn't critically
  //      low; we won't raid it for EV when solar is uncertain enough
  //      that PW recovery is at risk.
  //
  // Either false → existing hard-stop applies. The engine still
  // re-evaluates every 5 min, so a forecast revision or PW recovery
  // mid-morning will flip the rule live.
  //
  // schema: parked_schedule[0]=Sun ... parked_schedule[6]=Sat.
  const todayDow = ptDow(now);
  const todayParked = config.parked_schedule?.[todayDow] ?? true;
  // Pre-departure mode: cable is plugged in this morning but the car
  // leaves mid-day. When this flag is true the rate logic flips from
  // PW-first (spread budget) to car-first (instantaneous surplus) and
  // the PW-trajectory hard-stop is bypassed. See the rate-formula
  // branch below for the full rationale.
  let preDepartureMode = false;
  if (!todayParked) {
    const todayKwh = forecast.daily[0]?.kwh ?? 0;
    const isHighEnergyDay = todayKwh >= config.surplus_forecast_kwh;
    const pwAboveFloor = snapshot.pw_soc >= config.morning_pw_floor_pct;

    if (isHighEnergyDay && pwAboveFloor) {
      preDepartureMode = true;
      reasoning.push(
        `${DAY_NAMES[todayDow]} not parked, but pre-departure window: ` +
          `forecast ${todayKwh} kWh ≥ ${config.surplus_forecast_kwh} ` +
          `+ PW ${snapshot.pw_soc}% ≥ ${config.morning_pw_floor_pct}% floor. ` +
          `Pre-charging EV (car-first rate, PW takes spillover).`,
      );
      // Fall through to Gate 3 + sunset check; pre-departure branch
      // below skips trajectory + spread budget.
    } else {
      const why: string[] = [];
      if (!isHighEnergyDay) {
        why.push(
          `forecast ${todayKwh} kWh < ${config.surplus_forecast_kwh} threshold`,
        );
      }
      if (!pwAboveFloor) {
        why.push(
          `PW ${snapshot.pw_soc}% < ${config.morning_pw_floor_pct}% floor`,
        );
      }
      return {
        action: "stop",
        reason: "Today is not a parked day",
        reasoning: [
          `${DAY_NAMES[todayDow]} marked as away in parked schedule.`,
          `Pre-departure relaxation declined: ${why.join("; ")}.`,
        ],
      };
    }
  }

  // Gate 3: EV at-or-above its target SoC. Two stop conditions, lower
  // wins:
  //   - snapshot.ev_target — Rivian's own charge limit, set in the
  //     Rivian app (default 80% for NMC battery longevity). Source of
  //     truth for "the user's intended SoC ceiling for this car."
  //   - config.ev_solar_boost_cap_pct — Helios-side override. Default
  //     100 (no effect); user lowers it only to enforce a stricter
  //     ceiling than whatever Rivian is currently set to.
  // When the lower of these two is reached, the engine stops the EV so
  // remaining solar surplus flows to the PW (until 100%) and then to
  // the grid.
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
          `Stop EV — solar tops PW (if not yet at 100%), then exports.`,
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

  // --- Pre-departure branch: car-first rate, no PW priority ---
  // On non-parked-but-relaxed mornings the cable will disconnect
  // mid-day. Solar that arrives after disconnect either fills PW
  // (until 100%) or exports at NEM ~$0.04/kWh — wasted. The user's
  // intent for these mornings is "soak surplus solar into the EV
  // FIRST; PW takes whatever spills over from car-can't-absorb."
  //
  // That means we deliberately bypass:
  //   - the PW trajectory check (which would stop EV when PW is
  //     filling slowly — exactly what we expect when car is eating
  //     most of the surplus)
  //   - the spread-budget rate formula (which is conservative by
  //     design, throttling EV so PW catches up over the day)
  //
  // Instead: instantaneous surplus = solar − house, capped at the
  // car's max charge rate. Cron re-fires every 5 min so the rate
  // tracks live conditions. PW gets whatever the car can't absorb.
  //
  // Already-applied protections that still hold here:
  //   - Gate 2 required PW ≥ morning_pw_floor_pct before relaxing
  //   - Gate 3 stops the car at its SoC ceiling
  //   - past-cutoff handler runs above (so this is daytime only)
  if (preDepartureMode) {
    const houseW = Math.max(0, snapshot.home_w - snapshot.ev_w);
    const surplusKw = Math.max(0, (snapshot.solar_w - houseW) / 1000);
    const desiredRateKw = +Math.min(
      surplusKw,
      system.vehicle.max_charge,
    ).toFixed(2);
    reasoning.push(
      `Pre-departure mode — instantaneous surplus ${surplusKw.toFixed(2)} kW ` +
        `(solar ${(snapshot.solar_w / 1000).toFixed(1)} − ` +
        `house ${(houseW / 1000).toFixed(1)}). PW takes spillover.`,
    );

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
      reason: "Pre-departure — soak surplus solar into EV first",
      reasoning,
      desired_rate_kw: desiredRateKw,
    };
  }

  // --- PW trajectory check (replaces the old hard floor) ---
  // The previous version was a flat threshold: "PW below target →
  // stop EV." Too coarse. It blocked EV charging at noon on a
  // sunny day when PW was at 70% and filling at 10 kW — a state
  // where solar surplus is obviously enough for both PW recharge
  // *and* EV top-up.
  //
  // The right rule: PW must be either at target OR currently
  // recharging fast enough to hit target by cutoff. When PW is on
  // a healthy upward trajectory, surplus solar above what PW needs
  // is fair game for the EV; the budget calc below decides the
  // actual EV rate. When PW is *behind* its trajectory, we stop
  // the EV so all surplus goes to PW first.
  //
  // pw_w convention reminder: positive = discharging, negative =
  // charging (Tesla's gateway). pwChargeRateKw flips that sign so
  // higher = filling faster.
  const pwGapPct = config.pw_sunset_target_pct - snapshot.pw_soc;
  const pwGapKwh = +((pwGapPct / 100) * system.battery.total).toFixed(2);
  const hoursToCutoff = +((cutoffMs - now.getTime()) / 3_600_000).toFixed(2);

  if (pwGapKwh > 0) {
    const pwChargeRateKw = +(-snapshot.pw_w / 1000).toFixed(2);
    const pwNeededRateKw = +(
      pwGapKwh / Math.max(hoursToCutoff, 0.1)
    ).toFixed(2);
    // 0.5 kW tolerance smooths out the bouncy short-window case
    // where the trajectory math says "you need 0.4 kW" and the PW
    // is currently flat at 0 kW — that's a noise-level miss, not
    // a real problem.
    const TRAJECTORY_TOLERANCE_KW = 0.5;

    reasoning.push(
      `PW ${snapshot.pw_soc}% < target ${config.pw_sunset_target_pct}% ` +
        `(gap ${pwGapKwh} kWh; needs ≥${pwNeededRateKw} kW, ` +
        `currently ${pwChargeRateKw >= 0 ? "+" : ""}${pwChargeRateKw} kW).`,
    );

    if (pwChargeRateKw < pwNeededRateKw - TRAJECTORY_TOLERANCE_KW) {
      return {
        action: "stop",
        reason: "Powerwall behind trajectory — refill PW before EV",
        reasoning: [
          ...reasoning,
          `PW recharge rate too low. Stop EV so solar feeds PW. ` +
            `EV resumes when PW catches up or hits target.`,
        ],
      };
    }
    // PW on track. Fall through to the budget calc below.
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

  // pwGapKwh + hoursToCutoff already computed above for the trajectory
  // check; reuse here. Clamp to 0 so a negative gap (PW already over
  // target) doesn't actually *add* to the budget — surplus over target
  // isn't ours to spend, it's just headroom.
  const pwBudgetGapKwh = Math.max(0, pwGapKwh);
  const budget = +(solarRemaining - homeRemaining - pwBudgetGapKwh).toFixed(2);

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

  // Rate formula switches based on PW state:
  //
  //   - PW still below target (pwGapKwh > 0): use the spread budget,
  //     budget / hoursToCutoff. Conservative — PW recharge is the
  //     priority, EV gets a steady share of solar over the day.
  //
  //   - PW at/above target (pwGapKwh ≤ 0): use INSTANTANEOUS surplus,
  //     solar_w − house_w. This is what the user expects when the
  //     battery is full: every watt of headroom flows straight to the
  //     car at the current solar level, ramping up and down with
  //     production. Cron re-fires every 5 min so the schedule tracks
  //     real-time conditions without an explicit ramp.
  //
  // The instantaneous formula uses house_w (= home_w − ev_w) because
  // home_w from Tesla's load_power INCLUDES the EV draw. Subtracting
  // it gives "house only" load — the right number to subtract from
  // solar to get "what's left for the EV."
  let desiredRateKw: number;
  if (pwGapKwh <= 0) {
    const houseW = Math.max(0, snapshot.home_w - snapshot.ev_w);
    const surplusKw = Math.max(0, (snapshot.solar_w - houseW) / 1000);
    desiredRateKw = +Math.min(surplusKw, system.vehicle.max_charge).toFixed(2);
    reasoning.push(
      `PW at target — instantaneous surplus ${surplusKw.toFixed(2)} kW ` +
        `(solar ${(snapshot.solar_w / 1000).toFixed(1)} − house ${(houseW / 1000).toFixed(1)}).`,
    );
  } else {
    desiredRateKw = +Math.min(
      Math.max(0, budget / Math.max(hoursToCutoff, 0.1)),
      system.vehicle.max_charge,
    ).toFixed(2);
    reasoning.push(
      `Spread rate ${desiredRateKw} kW (budget ${budget} kWh / ${hoursToCutoff}h, ` +
        `capped at ${system.vehicle.max_charge} kW).`,
    );
  }

  // Minimum-rate gate: 6A × 240V ≈ 1.44 kW is the practical floor for
  // residential L2 charging — below that the car either rejects the
  // schedule outright or oscillates between draw and idle. Stop instead
  // of pushing a sub-minimum rate that the actuator chain can't honor.
  if (desiredRateKw < MIN_EV_RATE_KW) {
    return {
      action: "stop",
      reason: "Solar surplus too low for minimum charge rate",
      reasoning: [
        ...reasoning,
        `Desired ${desiredRateKw} kW < min ${MIN_EV_RATE_KW} kW (6A × 240V floor).`,
      ],
      budget_kwh: budget,
    };
  }

  return {
    action: "start",
    reason: "Solar budget available — charge car",
    reasoning: reasoning,
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
