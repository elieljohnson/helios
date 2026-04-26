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
  const today = overrides?.todayDate ?? { y: 2026, m: 4, d: 25 };
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
}) {
  return {
    snapshot: snap(over.snapshot),
    system: SYS_CONFIG,
    config: { ...DEFAULT_CONFIG, ...over.config },
    forecast: forecast(over.forecastOver),
    home_curve: HOME_CURVE,
    now: ptHourToUtcDate(2026, 4, 25, over.hourPT),
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
    const d = decideEvCharge(
      inputs({
        snapshot: { pw_soc: 78, ev_plugged_in: true, ev_charging: false },
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
    // PW at 78% (already > target 80% by 2pp gap... wait 78 < 80, gap = 2%).
    const d = decideEvCharge(
      inputs({
        snapshot: { pw_soc: 78, ev_plugged_in: true, ev_charging: true },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("start");
    expect(d.budget_kwh).toBeGreaterThan(0);
    expect(d.desired_rate_kw).toBeGreaterThan(0);
    expect(d.desired_rate_kw).toBeLessThanOrEqual(SYS_CONFIG.vehicle.max_charge);
  });

  it("stops charging when PW is far below target and solar is weak", () => {
    // 13:00 PT, PW at 30% (need to fill ~50% of 40.5 kWh = ~20 kWh).
    // Force hourly solar low so budget goes negative.
    const lowSolar = new Map(Array.from({ length: 24 }, (_, h) => [h, 0.5]));
    const d = decideEvCharge(
      inputs({
        snapshot: { pw_soc: 30, ev_plugged_in: true, ev_charging: true },
        forecastOver: { hourlySolarOverride: lowSolar },
        hourPT: 13,
      }),
    );
    expect(d.action).toBe("stop");
    expect(d.budget_kwh!).toBeLessThanOrEqual(0);
    expect(d.reasoning.join(" ")).toMatch(/refill PW/i);
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
        config: { backstop_disabled_until: "2026-04-25" },
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
        config: { backstop_disabled_until: "2026-04-24" },
        forecastOver: { tomorrowKwh: 8 },
        hourPT: 23,
      }),
    );
    expect(d.action).toBe("start");
  });
});
