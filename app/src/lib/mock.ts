// Mocked status payload — ported from prototype/data.js "optimized" scenario.
// Replaces until Enphase/Tesla/Rivian integrations land.

import type {
  ActionsResponse,
  ForecastResponse,
  RatesResponse,
  StatusResponse,
} from "./types";

const solarCurve = Array.from({ length: 24 }, (_, h) => {
  if (h < 6 || h > 20) return 0;
  const t = (h - 6) / 14;
  const bell = Math.sin(t * Math.PI);
  const dip = h === 10 ? 0.82 : h === 11 ? 0.76 : 1;
  return +(9.5 * Math.pow(bell, 1.1) * dip).toFixed(2);
});

const homeCurve = Array.from({ length: 24 }, (_, h) => {
  const base = 0.9 + Math.sin(((h - 7) / 24) * Math.PI * 2) * 0.25;
  const evening = h >= 18 && h <= 22 ? 1.6 : 0;
  return +(base + evening).toFixed(2);
});

export function mockStatus(): StatusResponse {
  return {
    timestamp: new Date().toISOString(),
    snapshot: {
      self_sufficiency: 87,
      status_word: "Optimized",
      solar_w: 7700,
      home_w: 1400,
      ev_w: 5800,
      ev_soc: 62,
      ev_target: 80,
      ev_range: 295,
      ev_charging: true,
      ev_plugged_in: true,
      ev_source: { solar: 88, grid: 12 },
      ev_charged_today_kwh: 12.4,
      pw_w: 500,
      pw_soc: 78,
      pw_reserve: 20,
      pw_mode: "Self-powered",
      grid_w: 0,
      grid_direction: "idle",
      tou_period: "off-peak",
      tou_rate: 0.36,
      nem_export_rate: 0.04,
      daily_cost: 1.24,
      week_cost: 14.2,
      month_cost: 62.5,
      daily_export_kwh: 0,
    },
    system: {
      location: "Mill Valley, CA",
      utility: "PG&E E-TOU-C",
      coords: { lat: 37.897029, lng: -122.539091 },
      solar: { model: "Enphase IQ8X", count: 7, peak: 9.5 },
      battery: { count: 3, capacity: 13.5, total: 40.5, model: "Tesla Powerwall" },
      vehicle: { model: "Rivian R1S", capacity: 135, max_charge: 11.0 },
    },
    solar_curve: solarCurve,
    home_curve: homeCurve,
    // Raw mock payload — every domain is mock by definition. assembleStatus
    // overwrites this map per-domain as live overlays succeed; consumers
    // that read mockStatus() directly (tests, dev fallbacks) get the
    // honest "nothing here is real" tag set.
    sources: {
      solar: { provider: "mock", status: "mock" },
      home: { provider: "mock", status: "mock" },
      powerwall: { provider: "mock", status: "mock" },
      vehicle: { provider: "mock", status: "mock" },
    },
  };
}

export function mockForecast(): ForecastResponse {
  const hourly = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    solar: solarCurve[h],
    cloud: h < 10 ? 20 : h < 13 ? 45 : h < 17 ? 15 : 0,
    temp: 52 + Math.round(Math.sin(((h - 6) / 24) * Math.PI * 2) * 14),
  }));

  return {
    timestamp: new Date().toISOString(),
    hourly,
    daily: [
      { day: "Today", kwh: 42, icon: "sun", high: 68, low: 52, cloud: 15 },
      { day: "Thu", kwh: 38, icon: "cloud-sun", high: 66, low: 51, cloud: 35 },
      { day: "Fri", kwh: 22, icon: "cloud", high: 61, low: 49, cloud: 80 },
      { day: "Sat", kwh: 12, icon: "rain", high: 58, low: 48, cloud: 95 },
      { day: "Sun", kwh: 29, icon: "cloud-sun", high: 62, low: 50, cloud: 55 },
      { day: "Mon", kwh: 41, icon: "sun", high: 69, low: 52, cloud: 10 },
      { day: "Tue", kwh: 43, icon: "sun", high: 71, low: 54, cloud: 5 },
    ],
  };
}

export function mockActions(): ActionsResponse {
  const today = new Date().toISOString().slice(0, 10);
  const at = (hhmm: string) => `${today}T${hhmm}:00`;
  return {
    actions: [
      { timestamp: at("14:24"), display_time: "14:24", type: "reserve", title: "Raised Powerwall reserve to 92%", reason: "Rivian charging, 6.3 kW solar surplus — protect overnight headroom.", ok: true },
      { timestamp: at("14:06"), display_time: "14:06", type: "charge", title: "Began Rivian charge session", reason: "Surplus 5.4 kW > threshold 2.0 kW.", ok: true },
      { timestamp: at("13:48"), display_time: "13:48", type: "forecast", title: "Forecast updated — clear afternoon", reason: "Open-Meteo revised GHI +8%. Expect 42 kWh production today.", ok: true },
      { timestamp: at("11:20"), display_time: "11:20", type: "reserve", title: "Lowered reserve to 20%", reason: "Off-peak window open, allow discharge to home load.", ok: true },
      { timestamp: at("09:02"), display_time: "09:02", type: "info", title: "Morning TOU transition", reason: "Entered off-peak 9:00 AM. Paused EV preconditioning.", ok: true },
      { timestamp: at("07:31"), display_time: "07:31", type: "alert", title: "Solar underperforming forecast", reason: "Actual 1.1 kW vs. forecast 2.4 kW — light marine layer.", ok: false },
      { timestamp: at("05:00"), display_time: "05:00", type: "reserve", title: "Set overnight reserve to 30%", reason: "Peak-rate window ended; cushion for morning home load.", ok: true },
      { timestamp: at("00:01"), display_time: "00:01", type: "info", title: "New day — daily summary ready", reason: "87% self-sufficient yesterday. 38.2 kWh produced, 4.1 kWh exported.", ok: true },
    ],
  };
}

export function mockRates(): RatesResponse {
  return {
    utility: "PG&E E-TOU-C",
    schedule: [
      { period: "off-peak", from: "00:00", to: "15:00", rate: 0.32 },
      { period: "mid-peak", from: "15:00", to: "16:00", rate: 0.42 },
      { period: "peak", from: "16:00", to: "21:00", rate: 0.58 },
      { period: "mid-peak", from: "21:00", to: "00:00", rate: 0.42 },
    ],
  };
}
