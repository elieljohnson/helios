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
  it("regression 2026-05-06: authorizes EV when PW is at 100% near sunset", () => {
    // The bug that motivated the formula fix. ~18:57 PT (May 6),
    // sunset ~20:09 PT — about 72 min to sunset, 12 min to cutoff.
    // PW at 100% (40.5 kWh, way above sunset target of 80% =
    // 32.4 kWh). EV at 63%, target 80%. Dusk solar ~0 kW; house
    // ~1.9 kW.
    //
    // Old formula (broken): only subtracted catch-up, never added
    // headroom → available_for_ev ≈ 0.5 − 2.3 − 0 = −1.8 kWh →
    // refused even with 8 kWh of PW headroom sitting unused.
    //
    // New formula: signed pw_delta adds headroom on the positive
    // side → available_for_ev ≈ 0.5 − 2.3 + (effective_headroom)
    // = positive → authorize. Limit ends up a few % above current
    // EV SoC.
    const r = projectPwTrajectory({
      now: ptHourToUtcDate(2026, 5, 6, 19), // ~19:00 PT
      sunsetIso: sunsetIsoOn(2026, 5, 6, 20), // sunset 20:42 PT — ~100 min ahead
      hourly: makeHourly(0), // dusk
      home_curve: HOME_CURVE,
      pw_soc_pct: 100,
      ev_soc_pct: 63,
      todayParked: true,
      pw_sunset_safety_margin_pct: 5,
      ...PARKED_DEFAULTS,
    });
    expect(r.shouldStartNow).toBe(true);
    expect(r.evChargeLimitPct).toBeGreaterThan(63);
    expect(r.reasoning.join(" ")).toMatch(/PW headroom above sunset target/i);
    expect(r.reasoning.join(" ")).toMatch(/PW headroom.*\+/i);
  });

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
  it("regression 2026-05-07: clamps departure target at reserve floor (no grid imports)", () => {
    // The bug that caused today's $1.34 grid-import hit. ~7:32 AM
    // PT, sunny driving day, PW at 96%. Without the reserve-floor
    // clamp the projection authorized "PW drops to 0% by departure"
    // — the car drained PW to 20% (Tesla's actual floor) and the
    // remaining draw came from grid at $0.36/kWh off-peak.
    //
    // Fix: clamp pw_target_at_departure_kwh at pw_reserve_floor_kwh
    // (= 20% × 40.5 = 8.1 kWh) so the engine can't authorize plans
    // that imply grid imports. The result is a smaller drain budget
    // — the car gets less juice but the user pays $0 grid.
    const r = projectPwTrajectory({
      now: ptHourToUtcDate(2026, 5, 7, 7),
      sunsetIso: sunsetIsoOn(2026, 5, 7, 20),
      hourly: makeHourly(8), // strong sun
      home_curve: HOME_CURVE,
      pw_soc_pct: 96,
      ev_soc_pct: 58,
      todayParked: false,
      pw_sunset_safety_margin_pct: 5,
      pw_reserve_floor_pct: 20, // matches DEFAULT_CONFIG
      ...PARKED_DEFAULTS,
    });
    expect(r.shouldStartNow).toBe(true);
    expect(r.mode).toBe("driving");
    // The fix: projection must NOT recommend draining PW below the
    // reserve floor. Departure SoC has to land at or above 20%.
    expect(r.projectedDeparturePwPct).toBeDefined();
    expect(r.projectedDeparturePwPct!).toBeGreaterThanOrEqual(20);
  });

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

  it("DEFEND zone: refuses charging on a borderline forecast when PW is below sunset target", () => {
    // Today's actual scenario from 2026-05-04 morning. PW at 50%
    // (well below 80% target = defend zone). Cloudy-but-clearing
    // forecast where the integral budget hovers near zero. Without
    // the firm-buffer threshold the engine flapped between
    // refuse/authorize on tiny revisions; with it the decision is
    // stable until the forecast clearly firms up.
    //
    // 4 kW × 8.7h = ~35 kWh solar; house ~9 kWh; pw_gap (with 5%
    // safety margin → effective target 85% × 40.5 = 34.4 kWh) is
    // ~14 kWh from 50% (= 20.25 kWh). Available ≈ 35 - 9 - 14 = 12
    // kWh → seems positive. Need firmer test scenario.
    //
    // Use 1.8 kW solar (cloudier): 1.8 × 8.7 = 15.7 kWh; house 9 kWh;
    // pw_gap 14 kWh. Available ≈ -7 kWh. Defend zone refuses (would
    // refuse anyway under the old logic, but reasoning is clearer).
    const r = projectPwTrajectory({
      now: ptHourToUtcDate(2026, 5, 4, 11),
      sunsetIso: sunsetIsoOn(2026, 5, 4),
      hourly: makeHourly(1.8),
      home_curve: HOME_CURVE,
      pw_soc_pct: 50,
      ev_soc_pct: 50,
      todayParked: true,
      pw_sunset_safety_margin_pct: 5,
      ...PARKED_DEFAULTS,
    });
    expect(r.shouldStartNow).toBe(false);
    expect(r.reasoning.join(" ")).toMatch(/Zone: defend/i);
  });

  it("DEFEND zone refuses, COMFORT zone authorizes for the same borderline forecast", () => {
    // Find a forecast where the integral budget is positive but
    // not firmly so (between 0 and 4 kWh after pw_gap). Defend zone
    // requires 4 kWh; comfort has no gap from current PW SoC and so
    // the budget is ~6+ kWh higher → easily clears the comfort
    // threshold.
    //
    // 14:00 PT → sunset 19:42 ≈ 5.7h horizon. Solar 2.5 kW × 5.7 ≈
    // 14 kWh; mock house ~5–6 kWh; pw_gap (effective target 85%
    // with margin) from 70% = 6 kWh, from 96% = 0 kWh.
    //   - defend (PW 70): 14 − 5.7 − 6 ≈ 2.5 kWh → < 4 kWh firm
    //     buffer → refuse.
    //   - comfort (PW 96): 14 − 5.7 − 0 ≈ 8.5 kWh → authorize.
    const defend = projectPwTrajectory({
      now: ptHourToUtcDate(2026, 5, 4, 14),
      sunsetIso: sunsetIsoOn(2026, 5, 4),
      hourly: makeHourly(2.5),
      home_curve: HOME_CURVE,
      pw_soc_pct: 70,
      ev_soc_pct: 50,
      todayParked: true,
      pw_sunset_safety_margin_pct: 5,
      ...PARKED_DEFAULTS,
    });
    const comfort = projectPwTrajectory({
      now: ptHourToUtcDate(2026, 5, 4, 14),
      sunsetIso: sunsetIsoOn(2026, 5, 4),
      hourly: makeHourly(2.5),
      home_curve: HOME_CURVE,
      pw_soc_pct: 96,
      ev_soc_pct: 50,
      todayParked: true,
      pw_sunset_safety_margin_pct: 5,
      ...PARKED_DEFAULTS,
    });
    expect(defend.shouldStartNow).toBe(false);
    expect(comfort.shouldStartNow).toBe(true);
    expect(defend.reasoning.join(" ")).toMatch(/Zone: defend/i);
    expect(comfort.reasoning.join(" ")).toMatch(/Zone: comfort/i);
  });

  it("COMFORT zone: authorizes despite borderline-negative budget and names the trade-off", () => {
    // PW at 95% (well into comfort zone — above 80 + 5 margin + 10
    // buffer = 95). Forecast is so weak that the standard integral
    // budget goes negative. Comfort zone tolerates up to ~2 kWh
    // (5% of 40.5 capacity) of overdraft, so the engine authorizes.
    // The reasoning string explicitly names the trade-off so the
    // activity feed shows why we authorized despite borderline math.
    const r = projectPwTrajectory({
      now: ptHourToUtcDate(2026, 5, 4, 14),
      sunsetIso: sunsetIsoOn(2026, 5, 4),
      hourly: makeHourly(1.0), // very weak — budget goes negative
      home_curve: HOME_CURVE,
      pw_soc_pct: 95,
      ev_soc_pct: 50,
      todayParked: true,
      pw_sunset_safety_margin_pct: 5,
      ...PARKED_DEFAULTS,
    });
    expect(r.reasoning.join(" ")).toMatch(/Zone: comfort/i);
    if (r.shouldStartNow) {
      expect(r.reasoning.join(" ")).toMatch(
        /Comfort-zone authorization|headroom above sunset target/i,
      );
    }
  });

  it("refuses charge when ev_target is at or below ev_soc (defensive guard)", () => {
    // 2026-05-04 08:10 PT regression: pushed "Charge to ~70%" while
    // car was at 76%. The math shouldn't produce that, but a stale
    // snapshot.ev_target read or upstream race could land us here.
    // The guard refuses rather than push nonsense.
    const r = projectPwTrajectory({
      now: ptHourToUtcDate(2026, 5, 4, 11),
      sunsetIso: sunsetIsoOn(2026, 5, 4),
      hourly: makeHourly(8),
      home_curve: HOME_CURVE,
      pw_soc_pct: 80,
      ev_soc_pct: 76,
      todayParked: true,
      ...PARKED_DEFAULTS,
      ev_target_pct: 76, // user just set Rivian limit at current SoC
    });
    expect(r.shouldStartNow).toBe(false);
    expect(r.reason).toMatch(/no useful gain|already at/i);
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
