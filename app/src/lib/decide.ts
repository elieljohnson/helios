// Helios decision engine. Pure function — takes a snapshot + config and
// returns a proposed reserve target plus the reasoning chain. All side
// effects (writing to Tesla, logging, DB) happen in the caller.
//
// Priority cascade from PRD §4:
//   Solar → Home → EV → Powerwall → Grid
//
// The engine controls exactly one knob: Powerwall backup reserve %. It
// raises the reserve to block discharge (protecting headroom for peak or
// storms) and lowers it to allow discharge into home load (off-peak).

import type { EnergySnapshot, ConfigResponse, ForecastResponse } from "./types";

export type Decision = {
  /** Proposed reserve % to write to the Powerwall. */
  target_reserve_pct: number;
  /** Whether this differs from the current reserve by >= 5%. */
  should_act: boolean;
  /** Human-readable reasoning chain, ordered by evaluation. */
  reasoning: string[];
  /** Derived surplus after home + EV load, in kW. */
  surplus_kw: number;
};

export type DecideInput = {
  snapshot: EnergySnapshot;
  config: ConfigResponse;
  /** Today's hourly forecast, used for the storm guard. Optional. */
  forecast?: ForecastResponse;
};

export function decide({ snapshot, config, forecast }: DecideInput): Decision {
  const solar_kw = snapshot.solar_w / 1000;
  const home_kw = snapshot.home_w / 1000;
  const ev_kw = snapshot.ev_w / 1000;
  const surplus_kw = +(solar_kw - home_kw - ev_kw).toFixed(2);

  const reasoning: string[] = [];
  reasoning.push(
    `Solar ${solar_kw.toFixed(1)} kW, Home ${home_kw.toFixed(1)} kW, EV ${ev_kw.toFixed(1)} kW → surplus ${surplus_kw.toFixed(1)} kW.`,
  );

  let target = config.reserve_floor_pct;

  // Peak window guard: entering peak, block discharge so we hold energy.
  if (snapshot.tou_period === "peak") {
    target = Math.max(target, config.reserve_peak_pct);
    reasoning.push(
      `Peak window active — raise reserve to ${config.reserve_peak_pct}% to preserve stored energy.`,
    );
  } else if (snapshot.tou_period === "mid-peak") {
    target = Math.max(target, Math.round((config.reserve_floor_pct + config.reserve_peak_pct) / 2));
    reasoning.push(`Mid-peak — hold halfway between floor and peak ceiling.`);
  } else {
    reasoning.push(`Off-peak — allow discharge to home load, floor ${config.reserve_floor_pct}%.`);

    // Morning-bridge: when the sun is already up, we're still in deficit,
    // and today's forecast is sunny, lower the reserve target so the PW
    // can cover the small morning gap instead of importing from grid.
    // This is the only place in decide() where we LOWER the target
    // below floor — every other rule raises it. Safety conditions:
    //
    //   - off-peak only (peak/mid-peak guards already enforced above)
    //   - solar_w > 0: distinguishes morning ramp from overnight, so
    //     mock-data fallback or sensor noise can't trigger a midnight
    //     drain. (Companion to the daylight gate in decideEvCharge.)
    //   - solar_w < home_w: only when there's actually a deficit to
    //     bridge. Once solar exceeds home, the bridge naturally
    //     disengages and target snaps back to floor.
    //   - forecast >= surplus_forecast_kwh: high confidence that solar
    //     will refill what we discharge. Cloudy/storm days fall through
    //     to the storm guard below which raises target to 80%.
    //
    // The bridge can also fire in evening off-peak (after 9 PM) if
    // solar somehow > 0 — but post-sunset solar should be 0, so that
    // case is theoretical. If it ever happened, the conditions still
    // make sense: small deficit + sunny tomorrow + sun still up means
    // we're in the very brief pre-sunset off-peak window.
    if (
      forecast?.daily?.[0] &&
      snapshot.solar_w > 0 &&
      snapshot.solar_w < snapshot.home_w &&
      forecast.daily[0].kwh >= config.surplus_forecast_kwh
    ) {
      const bridgeFloor = config.morning_bridge_floor_pct;
      if (bridgeFloor < target) {
        target = bridgeFloor;
        reasoning.push(
          `Morning bridge — solar ${solar_kw.toFixed(1)} kW < home ${home_kw.toFixed(1)} kW ` +
            `with ${forecast.daily[0].kwh} kWh forecast today; ` +
            `lower reserve to ${bridgeFloor}% so PW covers the deficit.`,
        );
      }
    }
  }

  // Storm guard: if today's forecast total is meaningfully below the storm
  // threshold, raise reserve so we have overnight headroom.
  if (forecast && forecast.daily[0]) {
    const todayForecast = forecast.daily[0].kwh;
    if (todayForecast < config.storm_forecast_kwh) {
      target = Math.max(target, config.reserve_storm_pct);
      reasoning.push(
        `Forecast ${todayForecast} kWh < ${config.storm_forecast_kwh} kWh storm threshold — raise to ${config.reserve_storm_pct}% for headroom.`,
      );
    }
  }

  // Charging surplus guard: if we have a lot of surplus AND EV is charging,
  // protect the battery first — raise reserve so excess flows to PW, not
  // the car, preserving overnight capacity.
  if (surplus_kw > config.ev_charge_threshold_kw * 2 && snapshot.ev_charging) {
    target = Math.max(target, 40);
    reasoning.push(
      `Surplus ${surplus_kw.toFixed(1)} kW > 2× threshold while EV charging — nudge reserve to 40%.`,
    );
  }

  const should_act = Math.abs(target - snapshot.pw_reserve) >= 5;
  if (!should_act) {
    reasoning.push(
      `Target ${target}% within 5% of current ${snapshot.pw_reserve}% — no action.`,
    );
  } else {
    reasoning.push(
      `Target ${target}% differs from current ${snapshot.pw_reserve}% by ≥ 5% — act.`,
    );
  }

  return { target_reserve_pct: target, should_act, reasoning, surplus_kw };
}
