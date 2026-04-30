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

  // Reserve baseline: floor across ALL TOU periods. Earlier versions
  // raised reserve during peak (to "preserve stored energy") and to a
  // halfway point during mid-peak. That logic was a NEM 2.0 export-
  // arbitrage holdover — under NEM 2.0, peak-rate exports paid full
  // retail (~$0.58/kWh), so saving PW for peak export was profitable.
  //
  // Under NEM 3.0 (NBT), exports pay ~$0.04/kWh year-round — a flat
  // ACC rate that's ~15× lower than peak import. The arbitrage is gone.
  // The economically rational play during peak is to discharge PW into
  // home/EV loads to AVOID peak imports, not to hoard PW for export.
  //
  // The 2026-04-30 incident phase 2 is the textbook case: PW was sitting
  // at exactly reserve_peak_pct (60%) when the EV started drawing 11.1 kW
  // and the home load was 1.6 kW — the PW couldn't discharge below the
  // engine-imposed floor, so 12.7 kW imported from grid at peak rate.
  // Without the guard, the PW would have covered the entire load until
  // hitting the hardware floor (20%), saving ~$6 that night and ~$900
  // over a typical summer peak season.
  //
  // Ways reserve still legitimately gets raised below this point:
  //   - Storm guard (tomorrow's solar can't refill — preserve overnight)
  //   - User override via reserve_peak_pct config knob (opt-in NEM-2.0
  //     behavior, e.g. for hybrid tariffs where it still pencils)
  //
  // The reserve_peak_pct knob is preserved on the config type so a
  // future user with a non-default tariff can re-enable the guard from
  // Settings. It's just no longer applied by default.
  if (snapshot.tou_period === "peak") {
    reasoning.push(`Peak — discharge PW into home (NEM 3.0: imports cost > export credit).`);
  } else if (snapshot.tou_period === "mid-peak") {
    reasoning.push(`Mid-peak — discharge PW into home.`);
  } else {
    reasoning.push(`Off-peak — allow discharge to home load, floor ${config.reserve_floor_pct}%.`);

    // Morning-bridge: when the sun is already up, we're still in deficit,
    // and today's forecast is sunny, lower the reserve target so the PW
    // can cover the small morning gap instead of importing from grid.
    // This is the only place in decide() where we LOWER the target
    // below floor — every other rule raises it. Safety conditions:
    //
    //   - off-peak only (no peak/mid-peak special-cases above any more,
    //     but the gate is preserved as a structural marker — bridging
    //     is a morning-ramp concept that doesn't apply during peak
    //     hours when the sun is already past zenith)
    //   - solar_w > 0: distinguishes morning ramp from overnight, so
    //     mock-data fallback or sensor noise can't trigger a midnight
    //     drain. (Companion to the daylight gate in decideEvCharge.)
    //   - solar_w < home_w: only when there's actually a deficit to
    //     bridge. Once solar exceeds home, the bridge naturally
    //     disengages and target snaps back to floor.
    //   - forecast >= surplus_forecast_kwh: high confidence that solar
    //     will refill what we discharge. Cloudy/storm days fall through
    //     to the storm guard below which raises target to 80%.
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
