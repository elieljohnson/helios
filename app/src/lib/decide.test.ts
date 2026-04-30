import { describe, expect, it } from "vitest";
import { decide } from "./decide";
import { DEFAULT_CONFIG } from "./config";
import { mockStatus, mockForecast } from "./mock";
import type { EnergySnapshot } from "./types";

function baseSnapshot(overrides: Partial<EnergySnapshot> = {}): EnergySnapshot {
  return { ...mockStatus().snapshot, ...overrides };
}

describe("decide()", () => {
  it("holds at floor during off-peak with no guards firing", () => {
    const d = decide({
      snapshot: baseSnapshot({ pw_reserve: 20, tou_period: "off-peak" }),
      config: DEFAULT_CONFIG,
    });
    expect(d.target_reserve_pct).toBe(DEFAULT_CONFIG.reserve_floor_pct);
    expect(d.should_act).toBe(false);
  });

  it("holds at floor during peak — under NEM 3.0 we want PW to discharge", () => {
    // Pre-2026-04-30: this test asserted target == reserve_peak_pct.
    // That logic was a NEM 2.0 export-arbitrage holdover; under NEM 3.0
    // exports pay ~$0.04 vs ~$0.58 peak imports, so the cost-rational
    // play is to discharge PW through peak. The reserve_peak_pct config
    // knob is preserved for users on tariffs where the old behavior
    // still pencils, but it's no longer applied by default.
    const d = decide({
      snapshot: baseSnapshot({ pw_reserve: 20, tou_period: "peak" }),
      config: DEFAULT_CONFIG,
    });
    expect(d.target_reserve_pct).toBe(DEFAULT_CONFIG.reserve_floor_pct);
    expect(d.should_act).toBe(false);
    expect(d.reasoning.join(" ")).toMatch(/discharge PW/i);
  });

  it("holds at floor during mid-peak too", () => {
    const d = decide({
      snapshot: baseSnapshot({ pw_reserve: 20, tou_period: "mid-peak" }),
      config: DEFAULT_CONFIG,
    });
    expect(d.target_reserve_pct).toBe(DEFAULT_CONFIG.reserve_floor_pct);
    expect(d.should_act).toBe(false);
  });

  it("raises reserve to storm ceiling when forecast below threshold", () => {
    const forecast = mockForecast();
    forecast.daily[0].kwh = 8; // < storm_forecast_kwh (15)
    const d = decide({
      snapshot: baseSnapshot({ pw_reserve: 20, tou_period: "off-peak" }),
      config: DEFAULT_CONFIG,
      forecast,
    });
    expect(d.target_reserve_pct).toBe(DEFAULT_CONFIG.reserve_storm_pct);
    expect(d.should_act).toBe(true);
  });

  it("nudges reserve up when large surplus and EV charging", () => {
    // Surplus = 8 - 1.4 - 0 = 6.6 kW (> 2 * 2.0 kW threshold), EV charging
    const d = decide({
      snapshot: baseSnapshot({
        solar_w: 8000,
        home_w: 1400,
        ev_w: 0,
        ev_charging: true,
        pw_reserve: 20,
        tou_period: "off-peak",
      }),
      config: DEFAULT_CONFIG,
    });
    expect(d.target_reserve_pct).toBe(40);
    expect(d.surplus_kw).toBeCloseTo(6.6, 1);
  });

  it("does not act when target within 5% of current reserve", () => {
    const d = decide({
      snapshot: baseSnapshot({ pw_reserve: 18, tou_period: "off-peak" }),
      config: DEFAULT_CONFIG,
    });
    // Target is 20, current is 18 — within 5%.
    expect(d.should_act).toBe(false);
  });

  it("computes surplus = solar - home - ev", () => {
    const d = decide({
      snapshot: baseSnapshot({ solar_w: 5000, home_w: 2000, ev_w: 1500 }),
      config: DEFAULT_CONFIG,
    });
    expect(d.surplus_kw).toBe(1.5);
  });
});

describe("decide() — morning bridge", () => {
  // Real-world incident 2026-04-29: at 06:30 PT, solar 0.6 kW + home
  // 0.9 kW = 0.3 kW deficit. PW at 19% (just below 20% reserve), so
  // the engine held reserve at 20% and the house imported 0.2 kW from
  // grid. User reaction: "we have a battery, why are we importing?"
  // The bridge rule lowers reserve temporarily during the morning
  // ramp so PW can cover the deficit instead of importing.

  it("fires when sun is up + still in deficit + sunny day forecast", () => {
    const forecast = mockForecast();
    forecast.daily[0].kwh = 62; // well above surplus_forecast_kwh (40)
    const d = decide({
      snapshot: baseSnapshot({
        solar_w: 600,
        home_w: 900,
        ev_w: 0,
        tou_period: "off-peak",
        pw_reserve: 20,
      }),
      config: DEFAULT_CONFIG,
      forecast,
    });
    expect(d.target_reserve_pct).toBe(DEFAULT_CONFIG.morning_bridge_floor_pct);
    expect(d.target_reserve_pct).toBe(10);
    expect(d.reasoning.join(" ")).toMatch(/morning bridge/i);
  });

  it("does NOT fire pre-dawn (solar_w == 0)", () => {
    // The companion to the EV daylight gate: a midnight snapshot must
    // never trigger morning bridge, even if mock-data fallback or
    // sensor noise put plausible-looking values elsewhere in the
    // snapshot.
    const forecast = mockForecast();
    forecast.daily[0].kwh = 62;
    const d = decide({
      snapshot: baseSnapshot({
        solar_w: 0,
        home_w: 900,
        ev_w: 0,
        tou_period: "off-peak",
        pw_reserve: 20,
      }),
      config: DEFAULT_CONFIG,
      forecast,
    });
    expect(d.target_reserve_pct).toBe(DEFAULT_CONFIG.reserve_floor_pct);
    expect(d.reasoning.join(" ")).not.toMatch(/morning bridge/i);
  });

  it("does NOT fire when solar already covers home (deficit closed)", () => {
    // Once solar exceeds home demand, the deficit is gone, and there's
    // no reason to lower reserve. Bridge naturally disengages.
    const forecast = mockForecast();
    forecast.daily[0].kwh = 62;
    const d = decide({
      snapshot: baseSnapshot({
        solar_w: 3000,
        home_w: 900,
        ev_w: 0,
        tou_period: "off-peak",
        pw_reserve: 20,
      }),
      config: DEFAULT_CONFIG,
      forecast,
    });
    expect(d.target_reserve_pct).toBe(DEFAULT_CONFIG.reserve_floor_pct);
    expect(d.reasoning.join(" ")).not.toMatch(/morning bridge/i);
  });

  it("does NOT fire on cloudy/storm days", () => {
    // Below surplus_forecast_kwh threshold = uncertain solar = preserve
    // reserve for overnight. Storm guard at 80% takes over below the
    // storm_forecast_kwh threshold; in the band between (15-40 kWh)
    // we hold at reserve_floor_pct.
    const forecast = mockForecast();
    forecast.daily[0].kwh = 25; // above storm (15), below surplus (40)
    const d = decide({
      snapshot: baseSnapshot({
        solar_w: 600,
        home_w: 900,
        ev_w: 0,
        tou_period: "off-peak",
        pw_reserve: 20,
      }),
      config: DEFAULT_CONFIG,
      forecast,
    });
    expect(d.target_reserve_pct).toBe(DEFAULT_CONFIG.reserve_floor_pct);
    expect(d.reasoning.join(" ")).not.toMatch(/morning bridge/i);
  });

  it("does NOT fire during peak window (bridge is an off-peak-only concept)", () => {
    // Pre-2026-04-30: this test asserted the peak guard would override
    // the bridge to reserve_peak_pct. With the peak guard removed under
    // NEM 3.0, the target now stays at floor — and the bridge still
    // doesn't fire because its conditional is gated inside the
    // off-peak branch. Bridging is a morning-ramp concept tied to the
    // sun coming up; peak hours are after solar peak, so the rule
    // structurally doesn't apply even if the conditions accidentally
    // matched.
    const forecast = mockForecast();
    forecast.daily[0].kwh = 62;
    const d = decide({
      snapshot: baseSnapshot({
        solar_w: 600,
        home_w: 900,
        ev_w: 0,
        tou_period: "peak",
        pw_reserve: 20,
      }),
      config: DEFAULT_CONFIG,
      forecast,
    });
    expect(d.target_reserve_pct).toBe(DEFAULT_CONFIG.reserve_floor_pct);
    expect(d.reasoning.join(" ")).not.toMatch(/morning bridge/i);
  });

  it("respects a user-set bridge floor of 5%", () => {
    const forecast = mockForecast();
    forecast.daily[0].kwh = 62;
    const d = decide({
      snapshot: baseSnapshot({
        solar_w: 600,
        home_w: 900,
        ev_w: 0,
        tou_period: "off-peak",
        pw_reserve: 20,
      }),
      config: { ...DEFAULT_CONFIG, morning_bridge_floor_pct: 5 },
      forecast,
    });
    expect(d.target_reserve_pct).toBe(5);
  });

  it("disables itself when bridge floor equals reserve floor", () => {
    // User sets morning_bridge_floor_pct == reserve_floor_pct to opt
    // out. Bridge condition matches but the if-clause inside doesn't
    // lower the target, so reasoning chain shouldn't include the
    // morning-bridge line either.
    const forecast = mockForecast();
    forecast.daily[0].kwh = 62;
    const d = decide({
      snapshot: baseSnapshot({
        solar_w: 600,
        home_w: 900,
        ev_w: 0,
        tou_period: "off-peak",
        pw_reserve: 20,
      }),
      config: { ...DEFAULT_CONFIG, morning_bridge_floor_pct: 20 },
      forecast,
    });
    expect(d.target_reserve_pct).toBe(20);
    expect(d.reasoning.join(" ")).not.toMatch(/morning bridge/i);
  });
});
