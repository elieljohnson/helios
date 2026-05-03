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

import { projectPwTrajectory } from "./projectPwTrajectory";
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
  /** Recommended Rivian charge-limit % for this charging session. The
   *  car self-stops at this SoC — the user sets it manually in the
   *  Rivian app. Populated by the integral projection (driving-day
   *  branch); undefined under older code paths that don't compute it. */
  ev_charge_limit_pct?: number;
  /** Projected end-of-day PW SoC % under the recommended plan. Lets
   *  the push body include "PW drops to X% by departure, refills to
   *  Y% by sunset." Populated alongside ev_charge_limit_pct. */
  projected_end_pw_pct?: number;
  /** Projected PW SoC % at departure (driving-day plans only). */
  projected_departure_pw_pct?: number;
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

    // Daylight gate: pre-departure mode is fundamentally about diverting
    // SOLAR surplus into the EV. Engaging it before sunrise creates an
    // active charge schedule with no actual surplus to back it. Mock-
    // data fallback at 2 AM (incident 2026-04-29) demonstrated the
    // failure mode: phantom solar_w from mock lit up pre-departure mode
    // and pushed a 32A schedule overnight. Defense in depth alongside
    // the mock-data refusal in cron/decide: even if mock slips
    // through, no active schedule fires in the dark.
    //
    // Threshold: 200 W is comfortably above sensor noise / inverter
    // wake-up phantom readings (Tesla can show <50W parasitic in pre-
    // dawn) and well below useful production (>~1.5 kW for any
    // meaningful EV draw given the 6A floor).
    const DAYLIGHT_MIN_W = 200;
    const isDaylight = snapshot.solar_w >= DAYLIGHT_MIN_W;
    if (isHighEnergyDay && pwAboveFloor && isDaylight) {
      preDepartureMode = true;
      reasoning.push(
        `${DAY_NAMES[todayDow]} not parked, but pre-departure window: ` +
          `forecast ${todayKwh} kWh ≥ ${config.surplus_forecast_kwh} ` +
          `+ PW ${snapshot.pw_soc}% ≥ ${config.morning_pw_floor_pct}% floor ` +
          `+ solar ${(snapshot.solar_w / 1000).toFixed(1)} kW ≥ ${DAYLIGHT_MIN_W / 1000} kW. ` +
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
      if (!isDaylight) {
        why.push(
          `solar ${(snapshot.solar_w / 1000).toFixed(1)} kW < ${DAYLIGHT_MIN_W / 1000} kW (pre-dawn)`,
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

  // --- Pre-departure branch: forward-looking integral projection ---
  // On non-parked-but-relaxed mornings the cable will disconnect
  // mid-day. Solar that arrives after disconnect either fills PW
  // (until 100%) or exports at NEM ~$0.04/kWh — wasted. The user's
  // intent for these mornings is "soak as much of the day's solar
  // into the EV as possible — including, on strong-forecast days,
  // by deliberately draining PW into the car BEFORE departure to
  // make room for post-departure solar absorption."
  //
  // The previous version of this branch used instantaneous solar
  // surplus only — never authorized a PW drain, and could oscillate
  // start→stop within minutes when the car latched onto full L2 and
  // the dashboard's instantaneous surplus inverted (observed live
  // 2026-05-03 8:46→8:47 PT push start, 8:47 PT push stop). The new
  // projection answers a single question integrally: across the
  // pre-dep window AND the post-dep refill window, what charging
  // plan keeps PW ≥ sunset target while pushing as much energy as
  // possible into the car? That answer comes back as a recommended
  // Rivian charge-limit % (the car self-stops there) plus the live
  // recommended rate.
  //
  // Tariff-environment dependency: NEM 3.0 / NBT. The drain-PW-now
  // move pencils because every kWh routed to the car displaces a
  // future ~$0.40/kWh equivalent (avoided gasoline) instead of being
  // sold for $0.04 of credit. Under NEM 2.0 the calculus would be
  // approximately a wash and this would not pencil.
  // Invariant: import_rate >> export_rate.
  //
  // Already-applied protections that still hold here:
  //   - Gate 2 required PW ≥ morning_pw_floor_pct before relaxing
  //   - Gate 3 stops the car at its SoC ceiling
  //   - past-cutoff handler runs above (so this is daytime only)
  if (preDepartureMode) {
    const projection = projectPwTrajectory({
      now,
      sunsetIso,
      hourly: forecast.hourly,
      home_curve,
      pw_soc_pct: snapshot.pw_soc,
      pw_capacity_kwh: system.battery.total,
      pw_sunset_target_pct: config.pw_sunset_target_pct,
      pw_sunset_safety_margin_pct: config.pw_sunset_safety_margin_pct,
      ev_soc_pct: snapshot.ev_soc,
      ev_target_pct: snapshot.ev_target ?? evCap,
      ev_capacity_kwh: system.vehicle.capacity,
      ev_max_charge_kw: system.vehicle.max_charge,
      ev_live_charging_kw: snapshot.ev_w / 1000,
      todayParked: false,
    });
    reasoning.push(...projection.reasoning);

    if (!projection.shouldStartNow) {
      return {
        action: "stop",
        reason: projection.reason,
        reasoning,
        projected_end_pw_pct: projection.projectedEndOfDayPwPct,
        projected_departure_pw_pct: projection.projectedDeparturePwPct,
      };
    }

    return {
      action: "start",
      reason: projection.reason,
      reasoning,
      desired_rate_kw: projection.recommendedRateKw,
      ev_charge_limit_pct: projection.evChargeLimitPct,
      projected_end_pw_pct: projection.projectedEndOfDayPwPct,
      projected_departure_pw_pct: projection.projectedDeparturePwPct,
    };
  }

  // --- Parked-day integral projection ---
  //
  // Replaces three older branches that previously lived here:
  //   1. PW trajectory check (rate-based; "is PW recharging fast
  //      enough right now?")
  //   2. PW at/above target instantaneous-surplus branch
  //   3. PW below target spread-budget branch
  //
  // All three answered narrow questions about a single moment in time.
  // The integral projection answers the right question across the rest
  // of the day in one pass: walk hour-by-hour from now to sunset,
  // reserve enough solar to land PW at sunset target, and route the
  // remainder into the EV. Returns a recommended Rivian charge-limit %
  // (sunset target wins when forecast is short; partial EV charge is
  // accepted) and a projected end-of-day PW SoC for honest push copy.
  //
  // Tariff-environment dependency (per app/AGENTS.md): NEM 3.0 / NBT.
  // The "route surplus into EV instead of exporting" preference
  // requires `import_rate >> export_rate` — exports pay $0.04/kWh,
  // imports $0.36–$0.58/kWh. Under NEM 2.0 (legacy retail-rate
  // exports) the calculus would be approximately a wash; the
  // projection's choice to prefer EV over export would still be safe,
  // but the urgency that drives the rule disappears.
  // Invariant: import_rate >> export_rate.
  const projection = projectPwTrajectory({
    now,
    sunsetIso,
    hourly: forecast.hourly,
    home_curve,
    pw_soc_pct: snapshot.pw_soc,
    pw_capacity_kwh: system.battery.total,
    pw_sunset_target_pct: config.pw_sunset_target_pct,
    ev_soc_pct: snapshot.ev_soc,
    ev_target_pct: snapshot.ev_target ?? evCap,
    ev_capacity_kwh: system.vehicle.capacity,
    ev_max_charge_kw: system.vehicle.max_charge,
    ev_live_charging_kw: snapshot.ev_w / 1000,
    todayParked: true,
  });
  reasoning.push(...projection.reasoning);

  if (!projection.shouldStartNow) {
    return {
      action: "stop",
      reason: projection.reason,
      reasoning,
      projected_end_pw_pct: projection.projectedEndOfDayPwPct,
    };
  }

  return {
    action: "start",
    reason: projection.reason,
    reasoning,
    desired_rate_kw: projection.recommendedRateKw,
    ev_charge_limit_pct: projection.evChargeLimitPct,
    projected_end_pw_pct: projection.projectedEndOfDayPwPct,
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
