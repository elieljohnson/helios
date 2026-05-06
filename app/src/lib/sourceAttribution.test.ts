import { describe, expect, it } from "vitest";
import { mockStatus } from "./mock";
import {
  attributeEvDraw,
  attributePwCharge,
  attributePwDischarge,
  TICK_HOURS,
  wattsToKwh,
} from "./sourceAttribution";
import type { EnergySnapshot } from "./types";

function snap(over: Partial<EnergySnapshot> = {}): EnergySnapshot {
  return { ...mockStatus().snapshot, ...over };
}

describe("attributeEvDraw", () => {
  it("returns zero split when EV is not drawing", () => {
    const r = attributeEvDraw(snap({ ev_w: 0, solar_w: 5000, home_w: 1000 }));
    expect(r.load_w).toBe(0);
    expect(r.split).toEqual({ solar: 0, pw: 0, grid: 0 });
  });

  it("100% solar when surplus comfortably covers the EV", () => {
    // Solar 10kW − house 1kW = 9kW surplus. EV draws 5kW. All solar.
    const r = attributeEvDraw(
      snap({ solar_w: 10000, home_w: 6000, ev_w: 5000, pw_w: 0, grid_w: 0 }),
    );
    expect(r.split).toEqual({ solar: 5000, pw: 0, grid: 0 });
  });

  it("priority order: solar fills first, PW next, grid last", () => {
    // Extreme case for clarity. Solar 3kW, house 0 (excluding EV),
    // PW discharging 4kW, grid importing 4kW. EV drawing 11kW.
    // Expected: 3kW solar, 4kW PW, 4kW grid.
    const r = attributeEvDraw(
      snap({
        solar_w: 3000,
        home_w: 11000, // includes ev_w
        ev_w: 11000,
        pw_w: 4000,
        grid_w: 4000,
      }),
    );
    expect(r.split.solar).toBe(3000);
    expect(r.split.pw).toBe(4000);
    expect(r.split.grid).toBe(4000);
    expect(r.split.solar + r.split.pw + r.split.grid).toBe(r.load_w);
  });

  it("subtracts EV from home_w to find the real house surplus", () => {
    // home_w 4kW INCLUDES ev_w 3kW per Tesla convention. So house-
    // only is 1kW. With solar 5kW, surplus to feed EV is 4kW.
    // EV draws 3kW → fully solar.
    const r = attributeEvDraw(
      snap({
        solar_w: 5000,
        home_w: 4000,
        ev_w: 3000,
        pw_w: 0,
        grid_w: 0,
      }),
    );
    expect(r.split).toEqual({ solar: 3000, pw: 0, grid: 0 });
  });

  it("100% grid when solar is dark and PW is idle (overnight charge)", () => {
    const r = attributeEvDraw(
      snap({
        solar_w: 0,
        home_w: 11500,
        ev_w: 11000,
        pw_w: 0,
        grid_w: 11500,
      }),
    );
    expect(r.split).toEqual({ solar: 0, pw: 0, grid: 11000 });
  });
});

describe("attributePwCharge", () => {
  it("returns zero split when PW is not charging", () => {
    const r = attributePwCharge(snap({ pw_w: 5000 }));
    expect(r.load_w).toBe(0);
  });

  it("100% solar when surplus covers PW absorption", () => {
    // Solar 10kW − house 2kW = 8kW surplus. PW absorbing 5kW (pw_w
    // = -5000). All solar.
    const r = attributePwCharge(
      snap({ solar_w: 10000, home_w: 2000, pw_w: -5000, grid_w: 0 }),
    );
    expect(r.split).toEqual({ solar: 5000, pw: 0, grid: 0 });
  });

  it("splits between solar surplus and grid when both contribute", () => {
    // Solar 3kW, house 2kW → 1kW surplus. PW absorbing 4kW. So 1kW
    // solar + 3kW grid.
    const r = attributePwCharge(
      snap({ solar_w: 3000, home_w: 2000, pw_w: -4000, grid_w: 3000 }),
    );
    expect(r.split.solar).toBe(1000);
    expect(r.split.grid).toBe(3000);
  });
});

describe("attributePwDischarge", () => {
  it("attributes PW discharge between home and EV", () => {
    // EV draws 11kW, solar 3kW (1kW house + 0kW EV-relevant), pw_w
    // = 4kW discharging. EV gets all 4kW from PW (per attributeEvDraw),
    // home gets 0 from PW.
    const r = attributePwDischarge(
      snap({
        solar_w: 3000,
        home_w: 11000,
        ev_w: 11000,
        pw_w: 4000,
        grid_w: 4000,
      }),
    );
    expect(r.toEv).toBe(4000);
    expect(r.toHome).toBe(0);
  });

  it("returns zero split when PW is charging or idle", () => {
    expect(attributePwDischarge(snap({ pw_w: -5000 })).load_w).toBe(0);
    expect(attributePwDischarge(snap({ pw_w: 0 })).load_w).toBe(0);
  });
});

describe("wattsToKwh + TICK_HOURS", () => {
  it("converts watts × hours to kWh", () => {
    const split = { solar: 2000, pw: 1000, grid: 0 };
    const k = wattsToKwh(split, 1);
    expect(k.solar).toBe(2);
    expect(k.pw).toBe(1);
    expect(k.grid).toBe(0);
  });

  it("TICK_HOURS = 5 minutes (1/12 hour)", () => {
    expect(TICK_HOURS).toBeCloseTo(1 / 12, 5);
  });
});
