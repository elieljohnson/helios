// Pins Smartcar's percent→fraction conversion for setChargeLimit.
//
// Smartcar's V3 setChargeLimit endpoint takes a 0..1 decimal fraction
// as a STRING ("0.80"), not an integer percent. Our internal API uses
// integer percent (matching Rivian and the Helios UI). The conversion
// is the kind of footgun that doesn't surface until live, so we test it.

import { describe, expect, it } from "vitest";
import { socPctToFraction } from "./client";

describe("socPctToFraction", () => {
  it("converts common round percentages to two-decimal fraction strings", () => {
    expect(socPctToFraction(0)).toBe("0.00");
    expect(socPctToFraction(50)).toBe("0.50");
    expect(socPctToFraction(80)).toBe("0.80");
    expect(socPctToFraction(100)).toBe("1.00");
  });

  it("rounds non-integer percents to nearest whole percent before fractioning", () => {
    expect(socPctToFraction(73.4)).toBe("0.73");
    expect(socPctToFraction(73.6)).toBe("0.74");
    expect(socPctToFraction(99.9)).toBe("1.00");
  });

  it("clamps negative input to 0", () => {
    expect(socPctToFraction(-5)).toBe("0.00");
    expect(socPctToFraction(-100)).toBe("0.00");
  });

  it("clamps >100 input to 100", () => {
    expect(socPctToFraction(101)).toBe("1.00");
    expect(socPctToFraction(500)).toBe("1.00");
  });

  it("always returns a fixed-2-decimal string (no scientific notation, no trailing zeros stripped)", () => {
    // Two-decimal places matters for Smartcar's parsing — "0.5" might
    // parse the same as "0.50" but the documented format is two decimals.
    for (const v of [0, 1, 5, 50, 80, 99, 100]) {
      const out = socPctToFraction(v);
      expect(out).toMatch(/^[0-1]\.\d{2}$/);
    }
  });
});
