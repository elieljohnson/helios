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
    // PW @ 82 is above target (80) — engine uses the instantaneous-
    // surplus branch and returns desired_rate_kw without a budget.
    const d = decideEvCharge(
      inputs({
        snapshot: { pw_soc: 82, ev_plugged_in: true, ev_charging: false },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.desired_rate_kw).toBeGreaterThan(0);
  });
});

describe("decideEvCharge() — parked-day integral projection (Rule 2)", () => {
  it("authorizes charging when PW is below target with positive forecast budget", () => {
    // 1 PM PT, sunset 19:42 → ~6.7 hrs of solar to come.
    // PW @ 70% — 4 kWh below the 80% target. Default mock solar is
    // strong enough to cover house + PW catch-up + leave EV budget.
    // Projection populates ev_charge_limit_pct; the older budget_kwh
    // field is left unset on this code path.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          pw_soc: 70,
          pw_w: -3000,
          ev_plugged_in: true,
          ev_charging: true,
        },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.ev_charge_limit_pct).toBeDefined();
    expect(d.ev_charge_limit_pct!).toBeGreaterThan(0);
    expect(d.desired_rate_kw).toBeGreaterThan(0);
    expect(d.desired_rate_kw!).toBeLessThanOrEqual(SYS_CONFIG.vehicle.max_charge);
  });

  it("refuses to charge when PW is far below target and solar is weak", () => {
    // 13:00 PT, PW at 30% — well below sunset target. Cloudy: solar
    // 0.5 kW for the rest of the day. After PW catch-up, no budget
    // left for the EV. Projection refuses.
    const lowSolar = new Map(Array.from({ length: 24 }, (_, h) => [h, 0.5]));
    const d = decideEvCharge(
      inputs({
        snapshot: { pw_soc: 30, ev_plugged_in: true, ev_charging: true },
        forecastOver: { hourlySolarOverride: lowSolar },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/forecast too weak|sunset target/i);
  });

  it("caps recommended rate at vehicle.max_charge", () => {
    // Very early in the day with massive solar.
    const bigSolar = new Map(Array.from({ length: 24 }, (_, h) => [h, 9.5]));
    const d = decideEvCharge(
      inputs({
        snapshot: { pw_soc: 95, ev_plugged_in: true, ev_charging: true },
        forecastOver: { hourlySolarOverride: bigSolar },
        hourPT: 8,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.desired_rate_kw!).toBeLessThanOrEqual(SYS_CONFIG.vehicle.max_charge);
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

  it("hard-stops in pre-dawn even when forecast and PW pass — daylight gate", () => {
    // Real-world incident 2026-04-29: Tesla API failed at 02:10 PT, the
    // engine fell back to mockStatus() which has solar_w=7700 (a sunny
    // noon value) and pw_soc=78 — both above the pre-departure
    // thresholds. Without a daylight gate, pre-departure mode fired and
    // pushed a 32A overnight charge schedule from grid. Cost ~$6.73 in
    // imports + drained PW to floor.
    //
    // Belt-and-suspenders fix: the cron refuses to run on mock sources
    // (route.ts), AND pre-departure requires solar_w ≥ 200 W as a
    // physical sanity check. A non-zero pre-dawn snapshot from sensor
    // noise (~50 W parasitic on Tesla inverters) won't trip it; real
    // sunrise at >1 kW comfortably will.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 80, // would otherwise pass pwAboveFloor
          solar_w: 50, // pre-dawn sensor noise
        },
        date: { y: 2026, m: 4, d: 28 }, // Tue, non-parked
        hourPT: 4, // pre-dawn
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/not a parked day/i);
    expect(d.reasoning.join(" ")).toMatch(/pre-dawn/i);
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

describe("decideEvCharge() — PW protection (forecast-integral)", () => {
  // The integral projection replaces the old rate-based PW trajectory
  // check. It walks the rest of the day forward and asks "given the
  // forecast, will PW reach sunset target?" — instead of asking "is
  // PW recharging fast enough RIGHT NOW?" The new check is more
  // forgiving when forecast is strong (a flat-pw_w moment doesn't
  // matter if the day's solar more than covers the gap) and stricter
  // when forecast is weak (a fast-pw_w moment doesn't help if the
  // day's solar can't fill the gap by sunset).

  it("refuses charging late-afternoon when PW is far below target and forecast is short", () => {
    // 18:00 PT, ~0.7h to sunset. PW 56%, needs ~10 kWh recharge in
    // 0.7h — impossible from solar even at peak. Projection refuses.
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
    expect(d.reason).toMatch(/forecast too weak|sunset target/i);
  });

  it("authorizes EV charging when PW is below target but forecast covers the gap", () => {
    // Noon, peak solar (9.5 kW × 24h forecast). PW @ 70%, gap ~4 kWh.
    // Solar over remaining ~6 hrs ≈ 57 kWh, way more than gap +
    // house. Projection authorizes EV.
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
    expect(d.reasoning.join(" ")).toMatch(/Solar budget available for EV/i);
    expect(d.ev_charge_limit_pct).toBeDefined();
  });

  it("refuses EV charging when forecast can't cover PW gap regardless of current rate", () => {
    // Noon, weak forecast (1 kW all day). PW 50%, gap ~12 kWh.
    // Even with current pw_w = -5000 (catching up at 5 kW), the
    // FORECAST says only ~6 kWh of solar remaining — not enough.
    // Old rate-based check would have seen pw_w = -5000 and allowed
    // EV; new integral check correctly refuses.
    const weakSolar = new Map(Array.from({ length: 24 }, (_, h) => [h, 1]));
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 50,
          ev_soc: 50,
          pw_w: -5000,
        },
        forecastOver: { hourlySolarOverride: weakSolar },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/forecast too weak|sunset target/i);
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

  it("respects custom pw_sunset_target_pct (e.g. 90%) when forecast can't reach it", () => {
    // Target raised to 90 — PW @ 85 is now below target. Cloudy
    // forecast (0.7 kW all day) can't cover the new ~2 kWh gap +
    // house load. Projection refuses.
    const cloudy = new Map(Array.from({ length: 24 }, (_, h) => [h, 0.7]));
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 85,
          ev_soc: 50,
        },
        config: { pw_sunset_target_pct: 90 },
        forecastOver: { hourlySolarOverride: cloudy },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/forecast too weak|sunset target/i);
  });
});

describe("decideEvCharge() — recommended rate sourcing", () => {
  // Under Option B Helios doesn't actually set the charge rate (the
  // car draws what its OBC and the cable allow). The desired_rate_kw
  // field on EvDecision is informational — used in the activity feed
  // and (legacy paths) the push body. Sourcing rules:
  //   - When the Wall Connector reports live ev_w > 100 W: use that
  //     measured rate. The truth.
  //   - Otherwise: use the manufacturer cap (system.vehicle.max_charge)
  //     as the planning estimate.

  it("uses the manufacturer max as the rate estimate when EV is idle", () => {
    // PW at target, cable connected but ev_w = 0 (car idle). The
    // recommendation reflects the planning estimate, not a tiny live
    // rate that doesn't exist.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: false,
          pw_soc: 80,
          solar_w: 8000,
          home_w: 1400,
          ev_w: 0,
        },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.desired_rate_kw).toBe(SYS_CONFIG.vehicle.max_charge);
  });

  it("uses live measured rate from Wall Connector when actively charging", () => {
    // Live ev_w = 7 kW. The recommendation reflects measured truth,
    // not the manufacturer cap.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 85,
          solar_w: 9000,
          home_w: 1400,
          ev_w: 7000,
        },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.desired_rate_kw).toBe(7);
  });

  it("never exceeds vehicle.max_charge", () => {
    // Massive solar, PW well above target. Recommendation is bounded
    // by the manufacturer cap regardless of upstream conditions.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: false,
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

  it("refuses charging when the day's forecast is too weak even at PW target", () => {
    // PW at target, but forecast is cloudy (0.5 kW all day). After
    // covering house load, no budget remains for the EV. Projection
    // refuses — preferable to draining PW into the car when the day
    // can't refill it.
    const cloudy = new Map(Array.from({ length: 24 }, (_, h) => [h, 0.5]));
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
        forecastOver: { hourlySolarOverride: cloudy },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/forecast too weak|sunset target/i);
  });
});

describe("decideEvCharge() — driving-day integral projection", () => {
  // Driving-day mornings (non-parked + high forecast + PW above floor)
  // run through projectPwTrajectory's driving-day branch instead of
  // an instantaneous-surplus rate calc. The projection walks the rest
  // of the day forward — pre-dep window AND post-dep refill window —
  // and answers whether a charging plan exists where (a) the EV
  // gains as much as possible and (b) PW ends ≥ sunset target. This
  // explicitly authorizes draining PW into the car BEFORE departure
  // when post-departure solar will refill PW to target.

  it("authorizes drain-and-refill on a sunny driving morning", () => {
    // Tue (non-parked), 7 AM (2.5 h to 9:30 departure). PW 80%
    // (already at target). EV 50%. Strong solar all day. Projection
    // should authorize: PW can drain because post-dep solar comfortably
    // refills to sunset target.
    const bigSolar = new Map(Array.from({ length: 24 }, (_, h) => [h, 8]));
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 80,
          ev_soc: 50,
          solar_w: 6000,
          home_w: 700,
          ev_w: 0,
        },
        forecastOver: { hourlySolarOverride: bigSolar },
        date: { y: 2026, m: 4, d: 28 },
        hourPT: 7,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.reasoning.join(" ")).toMatch(/Driving day/i);
    expect(d.reasoning.join(" ")).toMatch(/refills.+by sunset/i);
  });

  it("uses live charging rate when actively charging", () => {
    // When the Wall Connector reports live ev_w, the recommendation
    // reflects measured rate (e.g. 7 kW) rather than the manufacturer
    // max (11 kW). This drives honest push copy under Option B.
    const bigSolar = new Map(Array.from({ length: 24 }, (_, h) => [h, 8]));
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 80,
          ev_soc: 50,
          solar_w: 9000,
          home_w: 1000,
          ev_w: 7000, // live measured 7 kW
        },
        forecastOver: { hourlySolarOverride: bigSolar },
        date: { y: 2026, m: 4, d: 28 },
        hourPT: 7,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.desired_rate_kw).toBe(7);
  });

  it("caps recommended rate at vehicle.max_charge when not actively charging", () => {
    // ev_w = 0 (cable connected but car not drawing). The
    // recommendation falls back to the manufacturer cap as the
    // planning estimate.
    const bigSolar = new Map(Array.from({ length: 24 }, (_, h) => [h, 8]));
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 80,
          ev_soc: 50,
          solar_w: 6000,
          home_w: 700,
          ev_w: 0,
        },
        forecastOver: { hourlySolarOverride: bigSolar },
        date: { y: 2026, m: 4, d: 28 },
        hourPT: 7,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.desired_rate_kw).toBe(SYS_CONFIG.vehicle.max_charge);
  });

  it("authorizes when PW is below sunset target if post-dep solar will refill", () => {
    // Tue (non-parked), PW @ 50% (below target), pw_w=0. The old
    // PW-trajectory check would hard-stop here. The projection sees
    // the strong post-dep solar curve and OKs it: PW drops or holds
    // through pre-dep, then refills past sunset target by sunset.
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
        hourPT: 8,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.reason).not.toMatch(/behind trajectory/i);
    expect(d.reasoning.join(" ")).toMatch(/Driving day/i);
  });

  it("refuses when forecast cannot sustain min L2 across pre-dep window", () => {
    // Cloudy hourly forecast — daily.kwh from the mock still passes
    // the gate-2 threshold (so pre-departure relaxation engages),
    // but the projection sees that hourly solar is too weak: pre-dep
    // delivered amount over 30 min can't sustain the 1.5 kW L2 floor.
    const cloudyHourly = new Map(
      Array.from({ length: 24 }, (_, h) => [h, 0.4]),
    );
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 50,
          ev_soc: 50,
          solar_w: 1200,
          home_w: 800,
          ev_w: 0,
        },
        forecastOver: { hourlySolarOverride: cloudyHourly },
        date: { y: 2026, m: 4, d: 28 },
        hourPT: 9,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/forecast too weak|sunset target/i);
  });
});
