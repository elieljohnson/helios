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
    // PW @ 82 keeps us above the Tier-1 floor so EV charging proceeds.
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

describe("decideEvCharge() — Tier 2 (PW at target, EV charging)", () => {
  it("starts charging when PW is at target and there's positive solar surplus", () => {
    // 1 PM PT. PW @ 82% — above target, so Tier 2 kicks in. Mock solar
    // exceeds mock house load → positive surplus → engine recommends
    // a non-zero rate up to max.
    const d = decideEvCharge(
      inputs({
        snapshot: { pw_soc: 82, ev_plugged_in: true, ev_charging: true },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.desired_rate_kw).toBeGreaterThan(0);
    expect(d.desired_rate_kw).toBeLessThanOrEqual(SYS_CONFIG.vehicle.max_charge);
  });

  it("caps charging rate at vehicle.max_charge", () => {
    // Massive instantaneous solar — surplus would suggest >11 kW.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          pw_soc: 95,
          ev_plugged_in: true,
          ev_charging: true,
          solar_w: 15000,
          home_w: 1000,
          ev_w: 0,
        },
        hourPT: 13,
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

  it("hard-stops on a non-parked day", () => {
    // Tuesday — schedule says car is away. Even with PW above target
    // and a healthy budget, engine refuses to charge.
    const d = decideEvCharge(
      inputs({
        snapshot: { ev_plugged_in: true, ev_charging: true, pw_soc: 90 },
        date: { y: 2026, m: 4, d: 28 },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/not a parked day/i);
    expect(d.reasoning.join(" ")).toMatch(/Tue/);
  });

  it("today gate fires before sunset gate (no forecast required)", () => {
    // Even with a borked forecast, the parked-day gate should still
    // hard-stop. Order matters — gate runs before sunset lookup.
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
  // The engine stops EV charging at min(snapshot.ev_target, ev_solar_boost_cap_pct).
  // Default boost_cap is 100, so by default the Rivian's own setting
  // (snapshot.ev_target = 80% in mock) is the effective stop point.
  // The cap is the user's Helios-side override for stricter ceilings.

  it("stops EV when at the Rivian's charge limit (snapshot.ev_target)", () => {
    // ev_soc = 80 = ev_target → engine stops; PW absorbs the surplus.
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
    // ev_soc 79 < ev_target 80 — engine routes surplus to car (Tier 2).
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
    // Rivian app set to 100 (road-trip mode); user wants Helios to
    // still cap at 85 normally. ev_soc=85 hits the Helios cap before
    // the Rivian limit.
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
    // Default boost_cap=100, Rivian=80, ev_soc=80 → stop at 80.
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
    // Past cutoff with EV already at limit. Engine should stop on the
    // limit gate, not fall through to the backstop branch — backstop
    // is for EV-critically-low, not full.
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

describe("decideEvCharge() — Tier 1: PW priority (strict waterfall)", () => {
  // Strict waterfall: PW must reach pw_sunset_target_pct (default 80%)
  // before EV gets any solar. No "trajectory" allowance — even if PW
  // is filling fast on its way to target, EV waits. Simpler mental
  // model than the previous trajectory-aware mode.

  it("stops EV when PW is below target, regardless of solar", () => {
    // PW at 56% — below the 80% target. Engine refuses EV. The reason
    // explicitly cites the priority order so the action log reads
    // sensibly.
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 56,
          ev_soc: 49,
        },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/Powerwall below target/i);
    expect(d.reasoning.join(" ")).toMatch(/refill PW/i);
  });

  it("stops EV even when PW is filling fast (no trajectory exception)", () => {
    // The previous "trajectory check" let the engine start EV when PW
    // was below target but recharging hard. The strict waterfall
    // doesn't grant that exception — PW must hit target first.
    const bigSolar = new Map(Array.from({ length: 24 }, (_, h) => [h, 9.5]));
    const d = decideEvCharge(
      inputs({
        snapshot: {
          ev_plugged_in: true,
          ev_charging: true,
          pw_soc: 70,
          ev_soc: 50,
          pw_w: -10000, // charging at 10 kW, would have passed trajectory
        },
        forecastOver: { hourlySolarOverride: bigSolar },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/Powerwall below target/i);
  });

  it("permits charging when PW is at the sunset target", () => {
    // pw_soc = target → Tier 1 satisfied → Tier 2 (charge with surplus).
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
    expect(d.reason).not.toMatch(/Powerwall below/i);
  });

  it("permits charging when PW is above target (Tier 3 transition: PW topping)", () => {
    // PW at 95% — above target. EV charges. PW continues filling to
    // 100% naturally as the engine's "instantaneous surplus" rate
    // doesn't include any PW deficit math.
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
    // the 80% sunset target. The Tier-1 gate must NOT block the
    // backstop; backstop pulls from the grid, not from PW. The check
    // for past-cutoff happens before the Tier-1 gate.
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

  it("respects custom pw_sunset_target_pct (e.g. 90%)", () => {
    // Target raised to 90 — PW @ 85 is now below target → stop EV.
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
    expect(d.reason).toMatch(/Powerwall below target/i);
  });
});

describe("decideEvCharge() — Tier 2 rate calc (instantaneous surplus)", () => {
  // Once PW is at/above target, the engine charges the EV at the
  // instantaneous solar surplus (solar − house, where house excludes
  // EV draw). Cron re-fires every 5 min so the schedule tracks
  // real-time conditions without an explicit ramp loop.

  it("uses instantaneous surplus when PW is at target", () => {
    // PW exactly at target. solar 8.0 kW, house = home_w − ev_w =
    // 1.4 − 0 = 1.4 kW. Surplus = 8.0 − 1.4 = 6.6 kW.
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
    expect(d.reasoning.join(" ")).toMatch(/Tier 2/i);
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
