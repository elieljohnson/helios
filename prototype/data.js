// Helios mock data — Mill Valley, CA. IQ8X 9.5kW, 3× Powerwall, Rivian R1.

window.HELIOS_DATA = (function () {
  // 24h arcs
  const solarCurve = Array.from({length: 24}, (_, h) => {
    if (h < 6 || h > 20) return 0;
    const t = (h - 6) / 14;
    const bell = Math.sin(t * Math.PI);
    // cloud dip around 10–11
    const dip = (h === 10 ? 0.82 : h === 11 ? 0.76 : 1);
    return +(9.5 * Math.pow(bell, 1.1) * dip).toFixed(2);
  });

  const homeCurve = Array.from({length: 24}, (_, h) => {
    const base = 0.9 + Math.sin((h - 7) / 24 * Math.PI * 2) * 0.25;
    const evening = h >= 18 && h <= 22 ? 1.6 : 0;
    return +(base + evening).toFixed(2);
  });

  const scenarios = {
    optimized: {
      label: 'Optimized',
      self_sufficiency: 87,
      status_word: 'Optimized',
      solar_w: 7700,     // 7.7 kW
      home_w: 1400,      // 1.4 kW
      ev_w: 5800,        // 5.8 kW (from solar surplus)
      ev_soc: 62,
      ev_target: 80,
      ev_range: 295,
      ev_charging: true,
      ev_source: { solar: 88, grid: 12 },
      pw_w: 500,         // +0.5 kW charging
      pw_soc: 78,
      pw_reserve: 20,
      pw_mode: 'Self-powered',
      grid_w: 0,
      grid_direction: 'idle',
      tou_period: 'off-peak',
      tou_rate: 0.32,
      daily_cost: 1.24,
      daily_savings: 6.80,
    },
    charging: {
      label: 'PRD scenario',
      self_sufficiency: 71,
      status_word: 'Charging',
      solar_w: 7700,
      home_w: 1400,
      ev_w: 11000,
      ev_soc: 45,
      ev_target: 80,
      ev_range: 215,
      ev_charging: true,
      ev_source: { solar: 58, grid: 0, battery: 42 },
      pw_w: -4700,
      pw_soc: 76,
      pw_reserve: 20,
      pw_mode: 'Self-powered',
      grid_w: 0,
      grid_direction: 'idle',
      tou_period: 'off-peak',
      tou_rate: 0.32,
      daily_cost: 2.18,
      daily_savings: 5.92,
    },
    peak: {
      label: 'Peak-rate evening',
      self_sufficiency: 42,
      status_word: 'Alert',
      solar_w: 0,
      home_w: 2300,
      ev_w: 0,
      ev_soc: 78,
      ev_target: 80,
      ev_range: 362,
      ev_charging: false,
      ev_source: { solar: 0, grid: 0, battery: 0 },
      pw_w: -2300,
      pw_soc: 48,
      pw_reserve: 30,
      pw_mode: 'Self-powered',
      grid_w: 0,
      grid_direction: 'idle',
      tou_period: 'peak',
      tou_rate: 0.58,
      daily_cost: 4.80,
      daily_savings: 3.10,
    },
  };

  const activity = [
    { t: '14:24', type: 'reserve', title: 'Raised Powerwall reserve to 92%', reason: 'Rivian charging, 6.3 kW solar surplus — protect overnight headroom.', ok: true },
    { t: '14:06', type: 'charge',   title: 'Began Rivian charge session', reason: 'Surplus 5.4 kW > threshold 2.0 kW.', ok: true },
    { t: '13:48', type: 'forecast', title: 'Forecast updated — clear afternoon', reason: 'Open-Meteo revised GHI +8%. Expect 42 kWh production today.', ok: true },
    { t: '11:20', type: 'reserve', title: 'Lowered reserve to 20%', reason: 'Off-peak window open, allow discharge to home load.', ok: true },
    { t: '09:02', type: 'info',    title: 'Morning TOU transition', reason: 'Entered off-peak 9:00 AM. Paused EV preconditioning.', ok: true },
    { t: '07:31', type: 'alert',   title: 'Solar underperforming forecast', reason: 'Actual 1.1 kW vs. forecast 2.4 kW — light marine layer.', ok: false },
    { t: '05:00', type: 'reserve', title: 'Set overnight reserve to 30%', reason: 'Peak-rate window ended; cushion for morning home load.', ok: true },
    { t: '00:01', type: 'info',    title: 'New day — daily summary ready', reason: '87% self-sufficient yesterday. 38.2 kWh produced, 4.1 kWh exported.', ok: true },
  ];

  const forecast24 = Array.from({length: 24}, (_, h) => ({
    hour: h,
    solar: solarCurve[h],
    cloud: h < 10 ? 20 : h < 13 ? 45 : h < 17 ? 15 : 0,
    temp: 52 + Math.round(Math.sin((h - 6) / 24 * Math.PI * 2) * 14),
  }));

  const forecast7 = [
    { day: 'Today', kwh: 42, icon: 'sun', high: 68, low: 52, cloud: 15 },
    { day: 'Thu',   kwh: 38, icon: 'cloud-sun', high: 66, low: 51, cloud: 35 },
    { day: 'Fri',   kwh: 22, icon: 'cloud', high: 61, low: 49, cloud: 80 },
    { day: 'Sat',   kwh: 12, icon: 'rain', high: 58, low: 48, cloud: 95 },
    { day: 'Sun',   kwh: 29, icon: 'cloud-sun', high: 62, low: 50, cloud: 55 },
    { day: 'Mon',   kwh: 41, icon: 'sun', high: 69, low: 52, cloud: 10 },
    { day: 'Tue',   kwh: 43, icon: 'sun', high: 71, low: 54, cloud: 5 },
  ];

  const system = {
    location: 'Mill Valley, CA',
    utility: 'PG&E E-TOU-C',
    solar: { model: 'Enphase IQ8X', count: 7, peak: 9.5 },
    battery: { count: 3, capacity: 13.5, total: 40.5, model: 'Tesla Powerwall' },
    vehicle: { model: 'Rivian R1T', capacity: 135, max_charge: 11.0 },
    powerwalls: [
      { id: 'PW-A', soc: 78, health: 100 },
      { id: 'PW-B', soc: 79, health: 99 },
      { id: 'PW-C', soc: 77, health: 100 },
    ],
  };

  const tou = [
    { period: 'off-peak', from: '00:00', to: '15:00', rate: 0.32 },
    { period: 'mid-peak', from: '15:00', to: '16:00', rate: 0.42 },
    { period: 'peak',     from: '16:00', to: '21:00', rate: 0.58 },
    { period: 'mid-peak', from: '21:00', to: '00:00', rate: 0.42 },
  ];

  return { scenarios, activity, forecast24, forecast7, solarCurve, homeCurve, system, tou };
})();
