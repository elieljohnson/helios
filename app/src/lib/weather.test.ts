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
  // Unix seconds for local-midnight in PT on each day starting 2026-04-25.
  // (PDT = UTC-7 → 07:00:00Z = 00:00 PT.) Exact values aren't asserted —
  // tests only check that day labels come back as strings.
  const DAY_STARTS_PT = [
    1777708800, // 2026-04-25 00:00 PT
    1777795200,
    1777881600,
    1777968000,
    1778054400,
    1778140800,
    1778227200,
  ];

  // 168 zeros for 7 days; we'll put real numbers only where tests need them.
  function makeRaw(overrides: Partial<{ ghi: number[]; codes: number[] }> = {}) {
    const radiation = overrides.ghi ?? new Array(168).fill(0);
    const dailyCodes = overrides.codes ?? new Array(7).fill(0);
    return {
      hourly: {
        time: Array.from({ length: 168 }, (_, i) => DAY_STARTS_PT[0] + i * 3600),
        temperature_2m: new Array(168).fill(60),
        cloud_cover: new Array(168).fill(20),
        shortwave_radiation: radiation,
        weather_code: new Array(168).fill(0),
      },
      daily: {
        time: DAY_STARTS_PT,
        weather_code: dailyCodes,
        temperature_2m_max: [68, 66, 61, 58, 62, 69, 71],
        temperature_2m_min: [52, 51, 49, 48, 50, 52, 54],
        cloud_cover_mean: [15, 35, 80, 95, 55, 10, 5],
        sunrise: DAY_STARTS_PT.map((s) => s + 6 * 3600 + 18 * 60),
        sunset: DAY_STARTS_PT.map((s) => s + 19 * 3600 + 42 * 60),
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

  it("passes through sunrise and sunset as ISO strings", () => {
    const out = transformForecast(makeRaw());
    expect(out.daily[0].sunrise).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(out.daily[0].sunset).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    // Sunset must follow sunrise.
    expect(new Date(out.daily[0].sunset!).getTime()).toBeGreaterThan(
      new Date(out.daily[0].sunrise!).getTime(),
    );
  });
});
