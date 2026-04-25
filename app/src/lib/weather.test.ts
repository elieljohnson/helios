import { describe, expect, it } from "vitest";
import { ghiToSolarKw, transformForecast, wmoToIcon } from "./weather";

describe("wmoToIcon()", () => {
  it("maps clear codes to sun", () => {
    expect(wmoToIcon(0)).toBe("sun");
    expect(wmoToIcon(1)).toBe("sun");
  });
  it("maps partly cloudy to cloud-sun", () => {
    expect(wmoToIcon(2)).toBe("cloud-sun");
  });
  it("maps overcast and fog to cloud", () => {
    expect(wmoToIcon(3)).toBe("cloud");
    expect(wmoToIcon(45)).toBe("cloud");
    expect(wmoToIcon(48)).toBe("cloud");
  });
  it("maps precipitation codes to rain", () => {
    expect(wmoToIcon(51)).toBe("rain"); // drizzle
    expect(wmoToIcon(63)).toBe("rain"); // rain
    expect(wmoToIcon(73)).toBe("rain"); // snow
    expect(wmoToIcon(95)).toBe("rain"); // thunder
  });
});

describe("ghiToSolarKw()", () => {
  it("returns 0 for night-time GHI", () => {
    expect(ghiToSolarKw(0)).toBe(0);
    expect(ghiToSolarKw(-5)).toBe(0);
  });
  it("scales linearly with GHI", () => {
    // 1000 W/m² × 9.5 kW × 0.85 efficiency = 8.075 kW
    expect(ghiToSolarKw(1000)).toBeCloseTo(8.08, 1);
    expect(ghiToSolarKw(500)).toBeCloseTo(4.04, 1);
  });
  it("respects custom peak and efficiency", () => {
    expect(ghiToSolarKw(1000, 10, 1)).toBe(10);
  });
});

describe("transformForecast()", () => {
  // 168 zeros for 7 days; we'll put real numbers only where tests need them.
  function makeRaw(overrides: Partial<{ ghi: number[]; codes: number[] }> = {}) {
    const radiation = overrides.ghi ?? new Array(168).fill(0);
    const dailyCodes = overrides.codes ?? new Array(7).fill(0);
    return {
      hourly: {
        time: new Array(168).fill("2026-04-25T00:00"),
        temperature_2m: new Array(168).fill(60),
        cloud_cover: new Array(168).fill(20),
        shortwave_radiation: radiation,
        weather_code: new Array(168).fill(0),
      },
      daily: {
        time: [
          "2026-04-25", "2026-04-26", "2026-04-27", "2026-04-28",
          "2026-04-29", "2026-04-30", "2026-05-01",
        ],
        weather_code: dailyCodes,
        temperature_2m_max: [68, 66, 61, 58, 62, 69, 71],
        temperature_2m_min: [52, 51, 49, 48, 50, 52, 54],
        cloud_cover_mean: [15, 35, 80, 95, 55, 10, 5],
      },
    };
  }

  it("produces 24 hourlies and 7 daily entries", () => {
    const out = transformForecast(makeRaw());
    expect(out.hourly).toHaveLength(24);
    expect(out.daily).toHaveLength(7);
    expect(out.hourly[0].hour).toBe(0);
    expect(out.hourly[23].hour).toBe(23);
  });

  it("labels day 0 as 'Today' and subsequent days with weekday short names", () => {
    const out = transformForecast(makeRaw());
    expect(out.daily[0].day).toBe("Today");
    expect(out.daily[1].day).toMatch(/^[A-Z][a-z]{2}$/);
  });

  it("sums hourly GHI into daily kWh totals", () => {
    // Day 0: 8 hours of 1000 W/m² → 8 × 8.075 ≈ 65 kWh; rest zero.
    const ghi = new Array(168).fill(0);
    for (let i = 8; i < 16; i++) ghi[i] = 1000;
    const out = transformForecast(makeRaw({ ghi }));
    expect(out.daily[0].kwh).toBeGreaterThanOrEqual(60);
    expect(out.daily[0].kwh).toBeLessThanOrEqual(70);
    expect(out.daily[1].kwh).toBe(0);
  });

  it("maps daily weather_code through wmoToIcon", () => {
    const out = transformForecast(makeRaw({ codes: [0, 2, 3, 63, 0, 0, 0] }));
    expect(out.daily[0].icon).toBe("sun");
    expect(out.daily[1].icon).toBe("cloud-sun");
    expect(out.daily[2].icon).toBe("cloud");
    expect(out.daily[3].icon).toBe("rain");
  });
});
