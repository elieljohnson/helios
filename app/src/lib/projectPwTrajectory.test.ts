import { describe, expect, it } from "vitest";
import { mockForecast, mockStatus } from "./mock";
import { projectPwTrajectory } from "./projectPwTrajectory";
import type { ForecastHour } from "./types";

// Mirrors the helper convention from decideEvCharge.test.ts.
function ptHourToUtcDate(
  year: number,
  month: number,
  day: number,
  hourPT: number,
): Date {
  // PDT = UTC-7. Tests use late-April / early-May dates so PDT applies.
  return new Date(Date.UTC(year, month - 1, day, hourPT + 7, 0, 0));
}

const SYSTEM = mockStatus().system;
const HOME_CURVE = mockStatus().home_curve;

function sunsetIsoOn(y: number, m: number, d: number, hourPT = 19): string {
  // Sunset at hourPT:42 PT; PDT = UTC-7.
  return new Date(Date.UTC(y, m - 1, d, hourPT + 7, 42, 0)).toISOString();
}

function makeHourly(solarKwByHour: number | Map<number, number>): ForecastHour[] {
  const base = mockForecast().hourly;
  if (typeof solarKwByHour === "number") {
    return base.map((h) => ({ ...h, solar: solarKwByHour }));
  }
  return base.map((h) => ({
    ...h,
    solar: solarKwByHour.get(h.hour) ?? h.solar,
  }));
}

const PARKED_DEFAULTS = {
  pw_capacity_kwh: SYSTEM.battery.total, // 40.5
  pw_sunset_target_pct: 80,
  ev_capacity_kwh: SYSTEM.vehicle.capacity, // 135
  ev_target_pct: 85,
  ev_max_charge_kw: SYSTEM.vehicle.max_charge, // 11
  ev_live_charging_kw: 0,
} as const;

describe("projectPwTrajectory — parked day", () => {
  it("authorizes a full charge on a sunny day with PW at target", () => {
    // 11 AM, sunset 19:42 → 8.7 h ahead. PW already at target (80%).
    // EV at 50%, target 85% → ~47 kWh gap. Sunny: 8 kW × 8.7h ≈ 70 kWh
    // of solar. House ~1 kW × 8.7h ≈ 9 kWh. Available for EV ≈ 61 kWh
    // — comfortably more than the 47 kWh gap.
    const r = projectPwTrajectory({
      now: ptHourToUtcDate(2026, 5, 4, 11),
      sunsetIso: sunsetIsoOn(2026, 5, 4),
      hourly: makeHourly(8),
      home_curve: HOME_CURVE,
      pw_soc_pct: 80,
      ev_soc_pct: 50,
      todayParked: true,
      ...PARKED_DEFAULTS,
    });
    expect(r.shouldStartNow).toBe(true);
    expect(r.mode).toBe("parked");
    expect(r.evChargeLimitPct).toBe(85);
    // Sunny day, EV gap ~47 kWh, available ~61 kWh → ~14 kWh of
    // leftover solar continues into PW above the 80% sunset target.
    // PW ends comfortably above target, not exactly at it.
    expect(r.projectedEndOfDayPwPct).toBeGreaterThan(80);
    expect(r.projectedEndOfDayPwPct).toBeLessThanOrEqual(100);
  });

  it("refuses to charge on a stormy parked day with PW already low", () => {
    // 11 AM, PW at 50% (below 80% target by 12.15 kWh). Cloudy: 1 kW
    // for the rest of the day → ~9 kWh of solar. House ~9 kWh.
    // Available for EV after PW catch-up: 9 − 9 − 12 = −12 kWh.
    const r = projectPwTrajectory({
      now: ptHourToUtcDate(2026, 5, 4, 11),
      sunsetIso: sunsetIsoOn(2026, 5, 4),
      hourly: makeHourly(1),
      home_curve: HOME_CURVE,
      pw_soc_pct: 50,
      ev_soc_pct: 50,
      todayParked: true,
      ...PARKED_DEFAULTS,
    });
    expect(r.shouldStartNow).toBe(false);
    expect(r.reason).toMatch(/sunset target|too weak/i);
    expect(r.evChargeLimitPct).toBe(50); // unchanged
  });

  it("recommends a partial charge when forecast caps it short of EV target", () => {
    // 11 AM, PW at 80% (target met, no catch-up needed). EV at 50%,
    // target 85% (47 kWh gap). Modest sun: 3 kW × 8.7h ≈ 26 kWh of
    // solar; house ~9 kWh; available ≈ 17 kWh — short of 47 kWh.
    // Recommended limit lands between 50% and 85%.
    const r = projectPwTrajectory({
      now: ptHourToUtcDate(2026, 5, 4, 11),
      sunsetIso: sunsetIsoOn(2026, 5, 4),
      hourly: makeHourly(3),
      home_curve: HOME_CURVE,
      pw_soc_pct: 80,
      ev_soc_pct: 50,
      todayParked: true,
      ...PARKED_DEFAULTS,
    });
    expect(r.shouldStartNow).toBe(true);
    expect(r.evChargeLimitPct).toBeGreaterThan(50);
    expect(r.evChargeLimitPct).toBeLessThan(85);
    expect(r.reasoning.join(" ")).toMatch(/partial|forecast-limited|sunset target wins/i);
  });
});

describe("projectPwTrajectory — driving day", () => {
  it("drains PW into car on a sunny driving morning", () => {
    // 7 AM, departure 9:30 → 2.5 h to drain PW into car.
    // PW at 80% (32.4 kWh), EV at 50% (47 kWh gap). Strong solar
    // forecast: 8 kW from 7 onward. Post-departure (9:30 → sunset
    // 19:42) is ~10 h × 8 kW = 80 kWh solar minus ~10 kWh house = 70
    // kWh surplus, well above the 32.4 kWh PW capacity. So PW can be
    // fully drained at departure (target floor is 0). Pre-dep solar
    // surplus: 2.5 h × ~7 kW = 17 kWh. Drain room: 32 kWh. Total ~49
    // kWh, but rate-capped at 11 kW × 2.5 h = 27.5 kWh and car-capped
    // at 47 kWh. Delivered ≈ 27.5 kWh → +20% SoC → final ~70%.
    const r = projectPwTrajectory({
      now: ptHourToUtcDate(2026, 5, 4, 7),
      sunsetIso: sunsetIsoOn(2026, 5, 4),
      hourly: makeHourly(8),
      home_curve: HOME_CURVE,
      pw_soc_pct: 80,
      ev_soc_pct: 50,
      todayParked: false,
      ...PARKED_DEFAULTS,
    });
    expect(r.shouldStartNow).toBe(true);
    expect(r.mode).toBe("driving");
    // PW should drop materially below where it started (drain was authorized).
    expect(r.projectedDeparturePwPct).toBeDefined();
    expect(r.projectedDeparturePwPct!).toBeLessThan(80);
    // PW should refill to at-or-above sunset target by end-of-day.
    expect(r.projectedEndOfDayPwPct).toBeGreaterThanOrEqual(80);
    // EV moved up but didn't necessarily reach the 85% limit (rate-capped).
    expect(r.evChargeLimitPct).toBeGreaterThan(50);
    expect(r.reasoning.join(" ")).toMatch(/Driving day/i);
  });

  it("refuses driving-day charge on a stormy morning", () => {
    // Same 7 AM departure window, but cloudy: 0.5 kW solar all day.
    // Post-departure surplus is negative (solar < house), so PW must
    // hold above sunset target floor itself, no drain authorized.
    // Pre-dep solar surplus tiny → sustained rate < 1.5 kW L2 floor.
    const r = projectPwTrajectory({
      now: ptHourToUtcDate(2026, 5, 4, 7),
      sunsetIso: sunsetIsoOn(2026, 5, 4),
      hourly: makeHourly(0.5),
      home_curve: HOME_CURVE,
      pw_soc_pct: 80,
      ev_soc_pct: 50,
      todayParked: false,
      ...PARKED_DEFAULTS,
    });
    expect(r.shouldStartNow).toBe(false);
    expect(r.mode).toBe("driving");
    expect(r.reason).toMatch(/forecast too weak/i);
  });

  it("safety margin reduces EV authorization on a forecast-marginal day", () => {
    // 11 AM. PW already at sunset target (80%). EV at 50%. Modest
    // sun: 4 kW × 8.7h ≈ 35 kWh; house ~9 kWh; available without
    // margin ≈ 26 kWh. Without margin, authorizes a partial EV
    // charge to ~70%. With a 10% safety margin (= 4 kWh held back),
    // authorized EV budget shrinks. Recommended limit % drops.
    const noMargin = projectPwTrajectory({
      now: ptHourToUtcDate(2026, 5, 4, 11),
      sunsetIso: sunsetIsoOn(2026, 5, 4),
      hourly: makeHourly(4),
      home_curve: HOME_CURVE,
      pw_soc_pct: 80,
      ev_soc_pct: 50,
      todayParked: true,
      pw_sunset_safety_margin_pct: 0,
      ...PARKED_DEFAULTS,
    });
    const withMargin = projectPwTrajectory({
      now: ptHourToUtcDate(2026, 5, 4, 11),
      sunsetIso: sunsetIsoOn(2026, 5, 4),
      hourly: makeHourly(4),
      home_curve: HOME_CURVE,
      pw_soc_pct: 80,
      ev_soc_pct: 50,
      todayParked: true,
      pw_sunset_safety_margin_pct: 10,
      ...PARKED_DEFAULTS,
    });
    expect(noMargin.shouldStartNow).toBe(true);
    expect(withMargin.shouldStartNow).toBe(true);
    expect(withMargin.evChargeLimitPct).toBeLessThan(
      noMargin.evChargeLimitPct,
    );
  });

  it("uses live charging rate when actively charging", () => {
    // Driving day, sunny, but the car is currently drawing 7 kW (not
    // the 11 kW max). The estimate should reflect the live rate.
    const r = projectPwTrajectory({
      now: ptHourToUtcDate(2026, 5, 4, 8),
      sunsetIso: sunsetIsoOn(2026, 5, 4),
      hourly: makeHourly(8),
      home_curve: HOME_CURVE,
      pw_soc_pct: 80,
      ev_soc_pct: 50,
      todayParked: false,
      ...PARKED_DEFAULTS,
      ev_live_charging_kw: 7,
    });
    expect(r.recommendedRateKw).toBe(7);
  });
});
