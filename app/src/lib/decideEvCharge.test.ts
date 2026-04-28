import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config";
import { decideEvCharge } from "./decideEvCharge";
import { mockForecast, mockStatus } from "./mock";
import type {
  ConfigResponse,
  EnergySnapshot,
  ForecastResponse,
  SystemConfig,
} from "./types";

// --- helpers --------------------------------------------------------

const SYSTEM = mockStatus().system;
const HOME_CURVE = mockStatus().home_curve;

// Build a "today in PT" Date at the given local hour. PDT = UTC-7 in
// late April, so PT 13:00 = 20:00 UTC.
function ptHourToUtcDate(year: number, month: number, day: number, hourPT: number): Date {
  return new Date(Date.UTC(year, month - 1, day, hourPT + 7, 0, 0));
}

// Default test date: Monday 2026-04-27. With DEFAULT_CONFIG.parked_schedule
// = [Sun=t, Mon=t, Tue=f, Wed=f, Thu=f, Fri=t, Sat=t], Mon is parked
// (gate passes) and Tue is not parked (so tomorrow-parked relaxation
// stays inert in the existing budget tests). Parked-schedule-specific
// tests pick their own dates.
const DEFAULT_TEST_DATE = { y: 2026, m: 4, d: 27 } as const;

function snap(overrides: Partial<EnergySnapshot> = {}): EnergySnapshot {
  return { ...mockStatus().snapshot, ...overrides };
}

function forecast(overrides?: {
  sunsetHourPT?: number;
  todayDate?: { y: number; m: number; d: number };
  hourlySolarOverride?: Map<number, number>;
  tomorrowKwh?: number;
}): ForecastResponse {
  const base = mockForecast();
  const today = overrides?.todayDate ?? DEFAULT_TEST_DATE;
  const sunsetHour = overrides?.sunsetHourPT ?? 19;
  // Sunset at sunsetHour:42 PT.
  const sunsetUtc = new Date(
    Date.UTC(today.y, today.m - 1, today.d, sunsetHour + 7, 42, 0),
  ).toISOString();
  const sunriseUtc = new Date(
    Date.UTC(today.y, today.m - 1, today.d, 6 + 7, 18, 0),
  ).toISOString();
  base.daily[0] = { ...base.daily[0], sunrise: sunriseUtc, sunset: sunsetUtc };
  if (overrides?.tomorrowKwh !== undefined) {
    base.daily[1] = { ...base.daily[1], kwh: overrides.tomorrowKwh };
  }
  if (overrides?.hourlySolarOverride) {
    base.hourly = base.hourly.map((h) => ({
      ...h,
      solar: overrides.hourlySolarOverride!.get(h.hour) ?? h.solar,
    }));
  }
  return base;
}

const SYS_CONFIG: SystemConfig = SYSTEM;

function inputs(over: {
  snapshot?: Partial<EnergySnapshot>;
  config?: Partial<ConfigResponse>;
  forecastOver?: Parameters<typeof forecast>[0];
  hourPT: number;
  /** Override the test date. Defaults to DEFAULT_TEST_DATE (Mon 2026-04-27). */
  date?: { y: number; m: number; d: number };
}) {
  const date = over.date ?? DEFAULT_TEST_DATE;
  // If the caller passes a custom date, the forecast's sunset/sunrise
  // anchor must move with it; otherwise the cutoff math compares now
  // (custom day) against sunset (default day) and falls into the
  // wrong branch.
  const fOver = over.date
    ? { ...over.forecastOver, todayDate: over.date }
    : over.forecastOver;
  return {
    snapshot: snap(over.snapshot),
    system: SYS_CONFIG,
    config: { ...DEFAULT_CONFIG, ...over.config },
    forecast: forecast(fOver),
    home_curve: HOME_CURVE,
    now: ptHourToUtcDate(date.y, date.m, date.d, over.hourPT),
  };
}

// --- tests ----------------------------------------------------------

describe("decideEvCharge() — gates", () => {
  it("holds when cable is not plugged in", () => {
    const d = decideEvCharge(inputs({ snapshot: { ev_plugged_in: false }, hourPT: 13 }));
    expect(d.action).toBe("hold");
    expect(d.reason).toMatch(/not plugged in/i);
  });

  it("re-evaluates and starts when plugged in but not actively charging (autonomy fix)", () => {
    // The autonomy bug pre-fix: gate was on ev_charging, so once the
    // engine stopped the car the next tick saw ev_charging=false and
    // returned "hold" forever. Post-fix: plug state is the gate, so the
    // engine continues to evaluate every tick and recommends start
    // when conditions justify it.
    // PW @ 82 keeps us above the floor so the budget branch is reached.
    const d = decideEvCharge(
      inputs({
        snapshot: { pw_soc: 82, ev_plugged_in: true, ev_charging: false },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.budget_kwh).toBeGreaterThan(0);
  });
});

describe("decideEvCharge() — daytime budget (Rule 2)", () => {
  it("starts charging when there's a positive budget", () => {
    // 1 PM PT, sunset 19:42 → cutoff 18:42, ~5 hrs of solar to come.
    // PW @ 82% — above the floor, so the budget branch decides.
    const d = decideEvCharge(
      inputs({
        snapshot: { pw_soc: 82, ev_plugged_in: true, ev_charging: true },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.budget_kwh).toBeGreaterThan(0);
    expect(d.desired_rate_kw).toBeGreaterThan(0);
    expect(d.desired_rate_kw).toBeLessThanOrEqual(SYS_CONFIG.vehicle.max_charge);
  });

  it("stops charging when PW is far below target and solar is weak", () => {
    // 13:00 PT, PW at 30% — well below the 80% sunset target. The
    // floor now preempts the budget calc; we don't even ask the
    // forecast whether solar will catch up.
    const lowSolar = new Map(Array.from({ length: 24 }, (_, h) => [h, 0.5]));
    const d = decideEvCharge(
      inputs({
        snapshot: { pw_soc: 30, ev_plugged_in: true, ev_charging: true },
        forecastOver: { hourlySolarOverride: lowSolar },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reasoning.join(" ")).toMatch(/(refills?|feeds?) PW/i);
  });

  it("caps charging rate at vehicle.max_charge", () => {
    // Very early in the day with massive solar — budget would suggest >11 kW.
    const bigSolar = new Map(Array.from({ length: 24 }, (_, h) => [h, 9.5]));
    const d = decideEvCharge(
      inputs({
        snapshot: { pw_soc: 95, ev_plugged_in: true, ev_charging: true },
        forecastOver: { hourlySolarOverride: bigSolar },
        hourPT: 8,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.desired_rate_kw).toBeLessThanOrEqual(SYS_CONFIG.vehicle.max_charge);
  });
});

describe("decideEvCharge() — sunset cutoff (Rule 1)", () => {
  it("stops charging past cutoff when nothing else fires", () => {
    // 20:00 PT — past cutoff (18:42). PW healthy, EV healthy.
    const d = decideEvCharge(
      inputs({
        snapshot: { ev_plugged_in: true, ev_charging: true, ev_soc: 70, pw_soc: 78 },
        hourPT: 20,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/sunset cutoff/i);
  });
});

describe("decideEvCharge() — off-peak backstop", () => {
  it("fires when EV low, tomorrow weak, off-peak, backstop enabled", () => {
    // 23:00 PT past cutoff, EV at 22% (< 30 min), tomorrow 8 kWh (< 15).
    // Mock TOU is "off-peak" by default in mockStatus().
    const d = decideEvCharge(
      inputs({
        snapshot: { ev_plugged_in: true, ev_charging: true, ev_soc: 22, tou_period: "off-peak" },
        forecastOver: { tomorrowKwh: 8 },
        hourPT: 23,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.reason).toMatch(/backstop/i);
  });

  it("does not fire when EV is healthy", () => {
    const d = decideEvCharge(
      inputs({
        snapshot: { ev_plugged_in: true, ev_charging: true, ev_soc: 60, tou_period: "off-peak" },
        forecastOver: { tomorrowKwh: 8 },
        hourPT: 23,
      }),
    );
    expect(d.action).toBe("stop");
  });

  it("does not fire when tomorrow's forecast is fine", () => {
    const d = decideEvCharge(
      inputs({
        snapshot: { ev_plugged_in: true, ev_charging: true, ev_soc: 22, tou_period: "off-peak" },
        forecastOver: { tomorrowKwh: 40 },
        hourPT: 23,
      }),
    );
    expect(d.action).toBe("stop");
  });

  it("does not fire during peak window even if EV is critically low", () => {
    const d = decideEvCharge(
      inputs({
        snapshot: { ev_plugged_in: true, ev_charging: true, ev_soc: 22, tou_period: "peak" },
        forecastOver: { tomorrowKwh: 8 },
        hourPT: 19,
      }),
    );
    expect(d.action).toBe("stop");
  });

  it("respects backstop_enabled = false", () => {
    const d = decideEvCharge(
      inputs({
        snapshot: { ev_plugged_in: true, ev_charging: true, ev_soc: 22, tou_period: "off-peak" },
        config: { backstop_enabled: false },
        forecastOver: { tomorrowKwh: 8 },
        hourPT: 23,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reasoning.join(" ")).toMatch(/backstop disabled/i);
  });

  it("respects backstop_disabled_until override", () => {
    const d = decideEvCharge(
      inputs({
        snapshot: { ev_plugged_in: true, ev_charging: true, ev_soc: 22, tou_period: "off-peak" },
        // Override = today (Mon 2026-04-27) → still active.
        config: { backstop_disabled_until: "2026-04-27" },
        forecastOver: { tomorrowKwh: 8 },
        hourPT: 23,
      }),
    );
    expect(d.action).toBe("stop");
  });

  it("backstop re-enables once the override date has passed", () => {
    const d = decideEvCharge(
      inputs({
        snapshot: { ev_plugged_in: true, ev_charging: true, ev_soc: 22, tou_period: "off-peak" },
        // Override = day before today → window has passed.
        config: { backstop_disabled_until: "2026-04-26" },
        forecastOver: { tomorrowKwh: 8 },
        hourPT: 23,
      }),
    );
    expect(d.action).toBe("start");
  });
});

describe("decideEvCharge() — parked_schedule", () => {
  // Default DEFAULT_CONFIG.parked_schedule is
  //   [Sun=t, Mon=t, Tue=f, Wed=f, Thu=f, Fri=t, Sat=t]
  // 2026-04-26 = Sun, 2026-04-27 = Mon, 2026-04-28 = Tue.
  //
  // Mock forecast.daily[0].kwh = 42, default surplus_forecast_kwh = 40,
  // default morning_pw_floor_pct = 20. So a non-parked day with
  // pw_soc ≥ 20 will RELAX (pre-departure charge enabled). To test the
  // hard-stop, drop one of the relaxation conditions.

  it("hard-stops on a non-parked day when PW is below the morning floor", () => {
    // Tue — schedule says car is away. PW @ 15% < 20% morning floor:
    // can't afford to pre-charge EV when PW recovery is at risk.
    const d = decideEvCharge(
      inputs({
        snapshot: { ev_plugged_in: true, ev_charging: true, pw_soc: 15 },
        date: { y: 2026, m: 4, d: 28 },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/not a parked day/i);
    expect(d.reasoning.join(" ")).toMatch(/Tue/);
    expect(d.reasoning.join(" ")).toMatch(/floor/i);
  });

  it("hard-stops on a non-parked day when forecast is low", () => {
    // Tue + PW above floor, but forecast 12 kWh < 40 surplus threshold.
    // PW won't easily refill — refuse pre-departure EV charge.
    const lowSolar = new Map(Array.from({ length: 24 }, (_, h) => [h, 0.5]));
    const base = inputs({
      snapshot: { ev_plugged_in: true, ev_charging: true, pw_soc: 80 },
      forecastOver: { hourlySolarOverride: lowSolar },
      date: { y: 2026, m: 4, d: 28 },
      hourPT: 13,
    });
    // Override the daily forecast kWh too — hourlySolarOverride
    // doesn't recompute the daily total.
    base.forecast.daily[0] = { ...base.forecast.daily[0], kwh: 12 };
    const d = decideEvCharge(base);
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/not a parked day/i);
    expect(d.reasoning.join(" ")).toMatch(/forecast 12 kWh/);
  });

  it("relaxes on a non-parked day when forecast is high AND PW above floor (pre-departure charge)", () => {
    // Tue, PW @ 80%, forecast = 42 kWh (mock default ≥ 40 surplus
    // threshold). Engine should pre-charge so morning solar lands in
    // the EV before the cable disconnects.
    const d = decideEvCharge(
      inputs({
        snapshot: { ev_plugged_in: true, ev_charging: true, pw_soc: 80 },
        date: { y: 2026, m: 4, d: 28 },
        hourPT: 9,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.reasoning.join(" ")).toMatch(/pre-departure/i);
    expect(d.desired_rate_kw).toBeGreaterThan(0);
  });

  it("respects a tighter user-set surplus_forecast_kwh threshold", () => {
    // Forecast = 42 kWh; user sets threshold to 50 → 42 < 50 → no
    // relaxation, hard-stop applies.
    const d = decideEvCharge(
      inputs({
        snapshot: { ev_plugged_in: true, ev_charging: true, pw_soc: 80 },
        config: { surplus_forecast_kwh: 50 },
        date: { y: 2026, m: 4, d: 28 },
        hourPT: 9,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/not a parked day/i);
  });

  it("today gate fires before sunset gate (no forecast required)", () => {
    // Even with a borked forecast, the parked-day gate should still
    // hard-stop — no daily kWh means isHighEnergyDay=false → relaxation
    // declined → return stop. Order matters: gate runs before sunset
    // lookup.
    const base = inputs({
      snapshot: { ev_plugged_in: true, ev_charging: true },
      date: { y: 2026, m: 4, d: 28 },
      hourPT: 13,
    });
    base.forecast = { ...base.forecast, daily: [] };
    const d = decideEvCharge(base);
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/not a parked day/i);
  });
});

describe("decideEvCharge() — Gate 3: EV at charge limit", () => {
  // Engine stops EV at min(snapshot.ev_target, ev_solar_boost_cap_pct).
  // Default boost_cap=100, so snapshot.ev_target (Rivian's app setting,
  // mock default 80) is the effective stop point. The cap is a
  // Helios-side override for stricter ceilings than Rivian.

  it("stops EV when at the Rivian's charge limit (snapshot.ev_target)", () => {
    // ev_soc=80 = ev_target → stop. Default boost_cap=100 doesn't fire.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 95,
          ev_soc: 80,
          ev_target: 80,
          solar_w: 9000,
          home_w: 1500,
          ev_w: 0,
        },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/charge limit/i);
    expect(d.reasoning.join(" ")).toMatch(/80%/);
  });

  it("stops EV when above the limit (e.g. user manually charged past it)", () => {
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 90,
          ev_soc: 92,
          ev_target: 80,
        },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/charge limit/i);
  });

  it("permits EV one bucket below the limit", () => {
    // ev_soc 79 < ev_target 80 — engine routes surplus to the car.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 85,
          ev_soc: 79,
          ev_target: 80,
          solar_w: 8000,
          home_w: 1400,
          ev_w: 0,
        },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("start");
  });

  it("respects a stricter Helios cap when Rivian limit is higher", () => {
    // Rivian app set to 100 (e.g., road-trip mode). User wants Helios
    // to still cap at 85 normally — boost_cap=85 fires before
    // ev_target=100.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 90,
          ev_soc: 85,
          ev_target: 100,
        },
        config: { ev_solar_boost_cap_pct: 85 },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/charge limit \(85%\)/i);
  });

  it("Rivian limit dominates when it's lower than the Helios cap", () => {
    // Default boost_cap=100, Rivian=80 → effective cap = 80.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 90,
          ev_soc: 80,
          ev_target: 80,
        },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/charge limit \(80%\)/i);
  });

  it("Gate 3 fires before sunset evaluation (no backstop for a charged EV)", () => {
    // Past cutoff with EV already at Rivian limit. Gate 3 stops first;
    // backstop is for EV-critically-low, not full.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          ev_soc: 85,
          ev_target: 80,
          pw_soc: 20,
          tou_period: "off-peak",
        },
        forecastOver: { tomorrowKwh: 8 },
        hourPT: 23,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/charge limit/i);
  });
});

describe("decideEvCharge() — PW trajectory check (core guardrail)", () => {
  // The original bug: PW dropped to 56% while EV charged at 11 kW
  // because the budget formula was forward-looking (trusted forecasted
  // solar) without checking actual PW recharge trajectory.
  //
  // Rule: PW must be at target OR currently recharging fast enough
  // to hit target by cutoff. When the trajectory is positive, we
  // allow surplus solar to reach the EV. When PW is behind, all
  // surplus goes to PW first.

  it("user-reported scenario reproduces: Sun 18:00 PT, PW 56%, PW idle/draining → stop", () => {
    // Late afternoon, only 0.7h to cutoff, PW needs ~14 kW recharge
    // rate to hit 80% — way more than possible. Trajectory fails.
    // Default mock pw_w = 500 (slight discharge), so charge rate < 0.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 56,
          ev_soc: 49,
        },
        date: { y: 2026, m: 4, d: 26 },
        hourPT: 18,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/behind trajectory/i);
    expect(d.reasoning.join(" ")).toMatch(/56% < target 80%/);
  });

  it("permits EV when PW is below target but recharging on track", () => {
    // Noon, peak solar forecast, PW @ 70% but charging hard at ~10 kW
    // (pw_w = -10000 W; negative = charging per Tesla convention).
    // pwGap = 10/100 × 40.5 = 4.05 kWh; hoursToCutoff ≈ 5.7h →
    // needed rate ≈ 0.7 kW. Currently 10 kW. Way on track. Allow EV.
    const bigSolar = new Map(Array.from({ length: 24 }, (_, h) => [h, 9.5]));
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 70,
          ev_soc: 50,
          pw_w: -10000,
        },
        forecastOver: { hourlySolarOverride: bigSolar },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.reasoning.join(" ")).toMatch(/needs ≥/);
    expect(d.budget_kwh).toBeGreaterThan(0);
  });

  it("stops EV when PW is below target AND recharging too slow", () => {
    // Noon, forecasted solar is fine, BUT PW is currently flat
    // (pw_w = 0) when it needs to be charging. Trajectory fails.
    const bigSolar = new Map(Array.from({ length: 24 }, (_, h) => [h, 9.5]));
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 50, // pwGap = 12.15 kWh; needs ~2.1 kW @ 5.7h
          ev_soc: 50,
          pw_w: 0, // flat, not charging
        },
        forecastOver: { hourlySolarOverride: bigSolar },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/behind trajectory/i);
  });

  it("permits charging when PW is at the sunset target", () => {
    // PW exactly at target — trajectory check skipped (gap = 0).
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 80,
          ev_soc: 50,
        },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.reason).not.toMatch(/Powerwall behind/i);
  });

  it("permits charging when PW is above the sunset target", () => {
    // PW well above target — gap < 0, trajectory check skipped.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 95,
          ev_soc: 50,
        },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("start");
  });

  it("does not block the off-peak backstop past cutoff (PW @ 20% reserve)", () => {
    // At night, PW sits at the 20% reserve floor by design — way below
    // the 80% sunset target. The trajectory check must NOT block the
    // backstop; backstop pulls from the grid, not from PW.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          ev_soc: 22,
          pw_soc: 20,
          tou_period: "off-peak",
        },
        forecastOver: { tomorrowKwh: 8 },
        hourPT: 23,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.reason).toMatch(/backstop/i);
  });

  it("respects custom pw_sunset_target_pct (e.g. 90%) when trajectory fails", () => {
    // Target raised to 90 — PW @ 85 is now below target. Default
    // mock pw_w = 500 (discharging), trajectory fails.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 85,
          ev_soc: 50,
        },
        config: { pw_sunset_target_pct: 90 },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/behind trajectory/i);
  });
});

describe("decideEvCharge() — rate calc by PW state", () => {
  // When PW is at/above target the engine should use instantaneous
  // surplus (solar − house) for the charge rate, ramping up and down
  // with current production. When PW is still below target it uses the
  // conservative budget-spread rate.

  it("uses instantaneous surplus when PW is at target", () => {
    // PW exactly at target. solar 8.0 kW, home_w 1.4 kW (mock default,
    // includes EV). With ev_charging=true and ev_w=0 we treat house as
    // home_w − ev_w = 1.4 kW. Surplus = 8.0 − 1.4 = 6.6 kW. The
    // budget formula at hour 13 would give a much lower rate
    // (~3-5 kW); instantaneous surplus reaches higher.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 80,
          solar_w: 8000,
          home_w: 1400,
          ev_w: 0,
        },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.desired_rate_kw).toBeCloseTo(6.6, 0);
    expect(d.reasoning.join(" ")).toMatch(/instantaneous surplus/i);
  });

  it("subtracts EV draw from home_w to get house-only surplus", () => {
    // home_w INCLUDES the EV (Tesla load_power convention). If we
    // didn't subtract, we'd see home as 5 kW and surplus as solar−5,
    // but the EV draw is part of that 5. Real surplus is solar minus
    // *house only*. With solar 8, home_w 5 (incl EV 3), house = 2 →
    // surplus = 6 kW.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 85,
          solar_w: 8000,
          home_w: 5000, // 2 kW house + 3 kW EV
          ev_w: 3000,
        },
        hourPT: 13,
      }),
    );
    expect(d.desired_rate_kw).toBeCloseTo(6.0, 0);
  });

  it("caps instantaneous surplus at vehicle.max_charge", () => {
    // Massive solar, tiny house, PW well above target → would suggest
    // 14 kW EV charge rate but car maxes at 11 kW.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 95,
          solar_w: 15000,
          home_w: 1000,
          ev_w: 0,
        },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.desired_rate_kw).toBe(SYS_CONFIG.vehicle.max_charge);
  });

  it("stops when surplus is below the 1.5 kW minimum charge rate", () => {
    // PW at target, but solar is currently weak (cloud rolled in) so
    // house ≈ solar. Surplus < 6A floor — pushing a sub-min schedule
    // is worse than not charging.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 80,
          solar_w: 1500,
          home_w: 1000,
          ev_w: 0,
        },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/minimum charge rate/i);
  });
});

describe("decideEvCharge() — pre-departure mode (car-first rate)", () => {
  // Pre-departure mornings (non-parked + high forecast + PW above
  // floor) flip the rate logic from PW-first (spread budget) to
  // car-first (instantaneous surplus). The point: dump every watt of
  // surplus solar into the EV before the cable disconnects, since
  // PW will fill from later-in-day solar regardless on a high-energy
  // day. PW takes whatever spills over from "car can't absorb."

  it("uses instantaneous surplus even when PW is below sunset target", () => {
    // Tue (non-parked), morning, PW @ 35% (below 80% target but above
    // 20% floor), solar 6.9 kW, house 0.7 kW. Spread budget would
    // throttle the car. Pre-departure mode pushes solar − house = 6.2 kW
    // to the EV directly.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 35,
          solar_w: 6900,
          home_w: 700,
          ev_w: 0,
        },
        date: { y: 2026, m: 4, d: 28 },
        hourPT: 9,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.desired_rate_kw).toBeCloseTo(6.2, 1);
    expect(d.reasoning.join(" ")).toMatch(/pre-departure/i);
    expect(d.reasoning.join(" ")).toMatch(/instantaneous surplus/i);
    expect(d.reason).toMatch(/soak surplus solar/i);
  });

  it("subtracts EV draw from home_w in pre-departure mode (no double-count)", () => {
    // Same convention as the PW-at-target case: home_w from Tesla's
    // load_power INCLUDES the EV. With solar 7 kW, home_w 4 kW (1 kW
    // house + 3 kW EV), surplus = solar − (home_w − ev_w) = 7 − 1 = 6.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 40,
          solar_w: 7000,
          home_w: 4000,
          ev_w: 3000,
        },
        date: { y: 2026, m: 4, d: 28 },
        hourPT: 9,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.desired_rate_kw).toBeCloseTo(6.0, 1);
  });

  it("caps pre-departure rate at vehicle.max_charge", () => {
    // Massive solar, tiny house. Without the cap we'd schedule
    // ~13 kW; the Rivian's onboard charger hard-stops at 11 kW.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 30,
          solar_w: 14000,
          home_w: 800,
          ev_w: 0,
        },
        date: { y: 2026, m: 4, d: 28 },
        hourPT: 9,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.desired_rate_kw).toBe(SYS_CONFIG.vehicle.max_charge);
  });

  it("bypasses the PW trajectory check that would otherwise hard-stop", () => {
    // Tue (non-parked), PW @ 50% (below target), pw_w=0 (flat — not
    // recharging). On a parked day this is the "stops EV when PW is
    // below target AND recharging too slow" case. Pre-departure mode
    // intentionally bypasses that gate so the car gets surplus first.
    const bigSolar = new Map(Array.from({ length: 24 }, (_, h) => [h, 9.5]));
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 50,
          ev_soc: 50,
          solar_w: 7000,
          home_w: 700,
          ev_w: 0,
          pw_w: 0,
        },
        forecastOver: { hourlySolarOverride: bigSolar },
        date: { y: 2026, m: 4, d: 28 },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.reason).not.toMatch(/behind trajectory/i);
    expect(d.reasoning.join(" ")).toMatch(/pre-departure/i);
  });

  it("stops in pre-departure mode when surplus is below the 1.5 kW floor", () => {
    // Cloudy pre-departure morning: relaxation kicked in (high daily
    // forecast, PW above floor) but right now the panels barely beat
    // house load. Below 6A — refuse to push a sub-min schedule.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 50,
          solar_w: 1200,
          home_w: 800,
          ev_w: 0,
        },
        date: { y: 2026, m: 4, d: 28 },
        hourPT: 9,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/minimum charge rate/i);
  });
});
