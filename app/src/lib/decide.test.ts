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

  it("raises reserve to peak ceiling during the peak window", () => {
    const d = decide({
      snapshot: baseSnapshot({ pw_reserve: 20, tou_period: "peak" }),
      config: DEFAULT_CONFIG,
    });
    expect(d.target_reserve_pct).toBe(DEFAULT_CONFIG.reserve_peak_pct);
    expect(d.should_act).toBe(true);
    expect(d.reasoning.join(" ")).toMatch(/peak window active/i);
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
