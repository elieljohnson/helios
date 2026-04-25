// Open-Meteo adapter. Returns a ForecastResponse using the same shape the
// PWA already renders, so wiring this into /api/forecast is invisible to
// the UI. No API key required (Open-Meteo Free is keyless under 10k/day).
//
// Solar production is estimated from GHI (shortwave_radiation):
//   solar_kw ≈ GHI/1000 × peak_kw × system_efficiency
// This ignores tilt/azimuth and panel temperature derate, but matches the
// real meter to within ~10% on clear days for a fixed-tilt array — fine
// for the storm guard and the 7-day card. Once Enphase lands, the actual
// production curve replaces this estimate; the forecast remains predictive.
//
// Location is currently hardcoded to the system's lat/lon. When this app
// goes multi-tenant, lat/lon move into user_config.
//
// Cache: Open-Meteo updates hourly. Next.js revalidate=600 (10 min) keeps
// us fresh without hammering the upstream.
//
// Reference: https://open-meteo.com/en/docs

import type { ForecastResponse, WeatherIcon } from "./types";

const MILL_VALLEY = { lat: 37.906, lon: -122.545 } as const;
const TIMEZONE = "America/Los_Angeles";
const SYSTEM_PEAK_KW = 9.5;
const SYSTEM_EFFICIENCY = 0.85;

// timeformat=unixtime makes all timestamps absolute (seconds since epoch),
// which sidesteps the "naive ISO + timezone" ambiguity that bites Node when
// the server is in UTC but Open-Meteo returned local-tz strings.
const OPEN_METEO_URL =
  "https://api.open-meteo.com/v1/forecast" +
  `?latitude=${MILL_VALLEY.lat}` +
  `&longitude=${MILL_VALLEY.lon}` +
  "&hourly=temperature_2m,cloud_cover,shortwave_radiation,weather_code" +
  "&daily=weather_code,temperature_2m_max,temperature_2m_min,cloud_cover_mean,sunrise,sunset" +
  "&temperature_unit=fahrenheit" +
  "&timeformat=unixtime" +
  `&timezone=${encodeURIComponent(TIMEZONE)}` +
  "&forecast_days=7";

// WMO weather interpretation codes → our six-icon vocabulary.
// https://open-meteo.com/en/docs#weathervariables
export function wmoToIcon(code: number): WeatherIcon {
  if (code <= 1) return "sun";          // 0 clear, 1 mainly clear
  if (code === 2) return "cloud-sun";   // 2 partly cloudy
  if (code === 3) return "cloud";       // 3 overcast
  if (code === 45 || code === 48) return "cloud"; // fog
  return "rain"; // 51–99: drizzle, rain, snow, showers, thunder
}

export function ghiToSolarKw(
  ghi_wm2: number,
  peak_kw: number = SYSTEM_PEAK_KW,
  efficiency: number = SYSTEM_EFFICIENCY,
): number {
  if (ghi_wm2 <= 0) return 0;
  return +((ghi_wm2 / 1000) * peak_kw * efficiency).toFixed(2);
}

// Shape of the Open-Meteo response we consume. With timeformat=unixtime,
// all `time` arrays are integer seconds since epoch.
type OpenMeteoResponse = {
  hourly: {
    time: number[];
    temperature_2m: number[];
    cloud_cover: number[];
    shortwave_radiation: number[];
    weather_code: number[];
  };
  daily: {
    time: number[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    cloud_cover_mean: number[];
    sunrise: number[];
    sunset: number[];
  };
};

export function transformForecast(
  raw: OpenMeteoResponse,
  now: Date = new Date(),
): ForecastResponse {
  // Hourly: take indices 0..23 (Open-Meteo returns hourlies starting at
  // local midnight today when timezone is set).
  const hourly = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    solar: ghiToSolarKw(raw.hourly.shortwave_radiation[h] ?? 0),
    cloud: Math.round(raw.hourly.cloud_cover[h] ?? 0),
    temp: Math.round(raw.hourly.temperature_2m[h] ?? 0),
  }));

  const dayLabels = raw.daily.time.map((unixSec, i) => {
    if (i === 0) return "Today";
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: TIMEZONE,
    }).format(new Date(unixSec * 1000));
  });

  // Daily kWh: sum hourly estimates per local day. Open-Meteo returns 168
  // hourlies for the 7-day forecast, so day d covers indices d*24..d*24+23.
  const daily = raw.daily.time.map((_, d) => {
    const start = d * 24;
    let kwh = 0;
    for (let i = 0; i < 24; i++) {
      kwh += ghiToSolarKw(raw.hourly.shortwave_radiation[start + i] ?? 0);
    }
    const sunriseSec = raw.daily.sunrise?.[d];
    const sunsetSec = raw.daily.sunset?.[d];
    return {
      day: dayLabels[d],
      kwh: Math.round(kwh),
      icon: wmoToIcon(raw.daily.weather_code[d] ?? 0),
      high: Math.round(raw.daily.temperature_2m_max[d] ?? 0),
      low: Math.round(raw.daily.temperature_2m_min[d] ?? 0),
      cloud: Math.round(raw.daily.cloud_cover_mean[d] ?? 0),
      sunrise: sunriseSec ? new Date(sunriseSec * 1000).toISOString() : undefined,
      sunset: sunsetSec ? new Date(sunsetSec * 1000).toISOString() : undefined,
    };
  });

  return {
    timestamp: now.toISOString(),
    hourly,
    daily,
  };
}

export async function fetchForecast(): Promise<ForecastResponse> {
  const res = await fetch(OPEN_METEO_URL, {
    next: { revalidate: 600 },
  });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const raw = (await res.json()) as OpenMeteoResponse;
  return transformForecast(raw);
}
