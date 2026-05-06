// Per-tick source attribution. Splits a load (EV draw or PW
// charging) across solar surplus / Powerwall discharge / grid import
// in proportional priority order. Used by:
//
//   - detectEvSession() — accumulates per-tick splits into the
//     ev_charge_sessions row's solar_kwh/pw_kwh/grid_kwh totals.
//   - rollupYesterday() — computes daily_summaries source columns
//     by walking yesterday's snapshots once.
//
// Why proportional / priority order:
//
//   Energy is fungible — once electrons hit the bus, "where did this
//   one come from" is a fiction. The honest answer is to apportion
//   by the most plausible source path. We use:
//     1. Solar surplus first (solar_w − house_w_excluding_load).
//        If solar has any headroom over house, the load is
//        attributed to solar up to that headroom.
//     2. PW discharge next. Whatever the load still needs that
//        solar didn't cover, PW supplies (up to its current
//        discharge rate).
//     3. Grid last. Anything still uncovered came from grid.
//
// This matches user intuition: "if it was sunny when I charged, it
// was a solar charge; if PW was discharging hard, the car drank from
// the battery; if I imported, that's grid." More forgiving "any
// solar present → 100% solar" attribution would inflate solar share
// on cloudy days; less forgiving "always proportional even with
// surplus" would understate solar on clear days.

import type { EnergySnapshot } from "./types";

export type SourceSplit = {
  /** kW (or kWh — units track the input). */
  solar: number;
  pw: number;
  grid: number;
};

export type AttributedLoad = {
  /** Total load being attributed, in W. */
  load_w: number;
  /** Source split, in W (matches load_w within rounding). */
  split: SourceSplit;
};

/**
 * Attribute the EV's instantaneous draw across solar / PW / grid.
 *
 * Inputs are watts; outputs are watts. Caller multiplies by tick
 * interval to convert to kWh when accumulating.
 *
 * Algorithm:
 *   house_excl_ev = max(0, home_w − ev_w)
 *     The ev_w is part of home_w in Tesla's load_power convention,
 *     so subtract to get the non-EV house load.
 *   solar_after_house = max(0, solar_w − house_excl_ev)
 *     Surplus solar available to feed the EV.
 *   solar_share = min(ev_w, solar_after_house)
 *     EV gets up to its draw from solar surplus.
 *   remaining = ev_w − solar_share
 *   pw_share  = min(remaining, max(0, pw_w))
 *     pw_w convention: positive = discharging. PW covers next.
 *   grid_share = remaining − pw_share
 *     Whatever's left came from grid (which equals grid_w when
 *     positive — importing — modulo tiny numerical noise).
 */
export function attributeEvDraw(snapshot: EnergySnapshot): AttributedLoad {
  const ev_w = Math.max(0, snapshot.ev_w);
  if (ev_w <= 0) {
    return { load_w: 0, split: { solar: 0, pw: 0, grid: 0 } };
  }
  const house_excl_ev = Math.max(0, snapshot.home_w - ev_w);
  const solar_after_house = Math.max(0, snapshot.solar_w - house_excl_ev);
  const solar_share = Math.min(ev_w, solar_after_house);
  const remaining_after_solar = ev_w - solar_share;
  const pw_discharge = Math.max(0, snapshot.pw_w);
  const pw_share = Math.min(remaining_after_solar, pw_discharge);
  const grid_share = Math.max(0, remaining_after_solar - pw_share);
  return {
    load_w: ev_w,
    split: { solar: solar_share, pw: pw_share, grid: grid_share },
  };
}

/**
 * Attribute the Powerwall's charging energy (when pw_w < 0) across
 * solar surplus / grid import.
 *
 * Convention: pw_w positive = discharging, negative = charging. So
 * a "charging" tick has |pw_w| watts flowing INTO the battery.
 *
 * Algorithm:
 *   pw_into = max(0, -pw_w)
 *     Watts flowing into PW.
 *   solar_after_house = max(0, solar_w − home_w)
 *     Note: home_w INCLUDES ev_w (Tesla load_power convention).
 *     EV is not a separate consumer to subtract here — house already
 *     covers the full domestic load.
 *   solar_share = min(pw_into, solar_after_house)
 *   grid_share  = pw_into − solar_share
 *     Whatever's left came from grid import.
 */
export function attributePwCharge(
  snapshot: EnergySnapshot,
): AttributedLoad {
  const pw_into = Math.max(0, -snapshot.pw_w);
  if (pw_into <= 0) {
    return { load_w: 0, split: { solar: 0, pw: 0, grid: 0 } };
  }
  const solar_after_house = Math.max(0, snapshot.solar_w - snapshot.home_w);
  const solar_share = Math.min(pw_into, solar_after_house);
  const grid_share = Math.max(0, pw_into - solar_share);
  return {
    load_w: pw_into,
    split: { solar: solar_share, pw: 0, grid: grid_share },
  };
}

/**
 * Attribute the Powerwall's discharge (when pw_w > 0) across home
 * load / EV draw destinations. (No "source" split — PW is the
 * source. Just where the energy went.)
 *
 * Algorithm:
 *   pw_out = max(0, pw_w)
 *   ev_share = min(pw_out, ev_w − solar_into_ev)
 *     EV's share of PW discharge is whatever portion of ev_w isn't
 *     already covered by solar surplus. We re-derive solar_into_ev
 *     here to keep this self-contained.
 *   home_share = pw_out − ev_share
 */
export function attributePwDischarge(
  snapshot: EnergySnapshot,
): { load_w: number; toHome: number; toEv: number } {
  const pw_out = Math.max(0, snapshot.pw_w);
  if (pw_out <= 0) return { load_w: 0, toHome: 0, toEv: 0 };
  const ev = attributeEvDraw(snapshot);
  // ev.split.pw is the portion of EV draw attributed to PW. That's
  // exactly the EV's share of PW discharge.
  const toEv = Math.min(pw_out, ev.split.pw);
  const toHome = Math.max(0, pw_out - toEv);
  return { load_w: pw_out, toHome, toEv };
}

/** Multiply a watts split by hours to convert to kWh. */
export function wattsToKwh(split: SourceSplit, hours: number): SourceSplit {
  return {
    solar: (split.solar * hours) / 1000,
    pw: (split.pw * hours) / 1000,
    grid: (split.grid * hours) / 1000,
  };
}

export const TICK_HOURS = 5 / 60; // cron tick = 5 min
