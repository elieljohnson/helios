// Snapshot assembly. Starts from the validated "optimized" mock and lets
// each connected provider overlay its real data. Today: Enphase replaces
// `solar_w`. Tomorrow: Tesla overlays the PW fields, Smartcar overlays
// the EV fields. The shape returned is unchanged — every consumer
// (status route, cron tick, preview-decision) keeps working the same.
//
// Failures from any provider degrade to the mock value rather than
// breaking the request. A `sources` field is attached so the UI can
// distinguish real vs. mocked fields without a second round-trip.

import {
  getEvChargedTodayKwh,
  getEvSourceTodaySplit,
  getConfig,
  getGridCostUsd,
  getGridExportKwh,
  getLearnedHomeCurve,
  getSelfSufficiencyTodayPct,
  getToken,
} from "./db";
import { getRateAt } from "./rates";
import { mockStatus } from "./mock";
import {
  isConfigured as rivianConfigured,
  getEvSnapshot as getRivianEvSnapshot,
} from "./rivian";
import {
  isConfigured as smartcarConfigured,
  getEvSnapshot,
} from "./smartcar";
import {
  isConfigured as teslaConfigured,
  getLiveStatus,
  getSiteInfo,
} from "./tesla";
import type { GridDirection, SnapshotSource, StatusResponse } from "./types";

export type AssembledStatus = StatusResponse;

export type AssembleOpts = {
  /** When true, skip the Enphase overlay entirely. Cron + preview-
   *  decision pass this so the engine path doesn't consume Enphase
   *  API budget — Tesla's `live_status.solar_power` is the fallback,
   *  which is ~5% off from Enphase's IQ8X-direct reading but updates
   *  every few seconds and shares Tesla's higher rate-limit ceiling.
   *  The 5% delta is negligible for the engine's kWh-budget math.
   *
   *  Default false: dashboard / `/api/status` keeps Enphase as the
   *  primary, more accurate source for human-facing display. */
  forEngine?: boolean;
};

export async function assembleStatus(opts: AssembleOpts = {}): Promise<AssembledStatus> {
  const base = mockStatus();
  base.timestamp = new Date().toISOString();

  // Per-domain provenance starts pessimistic: every field shows the mock
  // seed with status "mock". A successful overlay flips status to "live"
  // on the affected domains. A failed overlay (catch block) flips to
  // "unavailable" on the domains that never reached "live" — distinct
  // from "mock" so the dashboard can tell apart "Tesla isn't connected"
  // from "Tesla just broke." Engine gates treat both as not-live.
  const sources: AssembledStatus["sources"] = {
    solar: { provider: "mock", status: "mock" },
    home: { provider: "mock", status: "mock" },
    powerwall: { provider: "mock", status: "mock" },
    vehicle: { provider: "mock", status: "mock" },
  };

  // Track whether the Wall Connector observed physical current flow
  // on this assembly tick. Set to true when wc.wall_connector_power
  // > 100 W (real charging, well above sensor noise). Read later by
  // the Rivian overlay to gate the plug-state override.
  //
  // 2026-05-07 overnight incident: Rivian backend returned stale/
  // wrong chargerStatus values during a vendor outage; the Rivian
  // overlay then OVERWROTE the WC's correct "plugged" reading with
  // Rivian's incorrect "unplugged" reading. Engine treated the car
  // as unplugged for ~9 hours while it actually charged from PW
  // and then grid. ~$3.11 of unintended grid imports, no alarm.
  //
  // The fix: physical current at the connector is ground truth. If
  // WC sees > 100 W flowing, that current is reaching the car's
  // pack — there is no charging without it. Rivian's API can lie
  // about plug state; the wire can't.
  let wcObservedCurrent = false;

  /** Demote any domain in `domains` that isn't already "live" to a
   *  failed-overlay state pinned to `provider`. Used in catch blocks
   *  so a partial overlay (e.g. Tesla got home_w but threw before
   *  solar_w) doesn't get the failed half overwritten — only the
   *  fields that never made it. */
  const markUnavailable = (
    provider: SnapshotSource,
    domains: Array<keyof AssembledStatus["sources"]>,
  ) => {
    for (const d of domains) {
      if (sources[d].status !== "live") {
        sources[d] = { provider, status: "unavailable" };
      }
    }
  };

  // --- Enphase overlay removed -----------------------------------------
  // We used to query Enphase /summary for solar_w on the dashboard
  // path, with Tesla as a fallback. Two problems forced the swap:
  //
  //   1) The numbers didn't reconcile against Tesla. At one
  //      observation, Enphase reported 5.4 kW solar while Tesla's
  //      gateway reported 9.7 kW (with home 1.8 + PW charging 7.9 +
  //      grid 0 — i.e. a self-consistent 9.7 kW solar). A 4 kW delta
  //      means the supply/demand bars were structurally out of
  //      balance. Tesla's reading is system-consistent because every
  //      number (solar, home, PW, grid) comes from the same gateway
  //      at the same instant.
  //
  //   2) Enphase Watt plan caps at 1k API calls/month. The dashboard
  //      polled /api/status every 5 min — even a few hours/day of
  //      open dashboard use blew through the budget. Cron was
  //      already gated with forEngine: true; the dashboard path was
  //      the dominant remaining drain.
  //
  // The Enphase integration row + token + lib/enphase code remain in
  // place. Settings still shows the integration as connected and
  // reads /summary on demand for the integration health check. We
  // just don't call it from assembleStatus anymore. To re-enable as
  // primary, uncomment the block and decide on rate-limit handling.

  // --- Tesla overlay: home_w (load_power), pw_*, grid_w, AND solar ----
  // Tesla is now authoritative for ALL four power flows. Reading them
  // from one source guarantees the supply/demand math reconciles
  // (conservation of energy: solar + grid_in + pw_discharge =
  // home + ev + grid_out + pw_charge, within measurement noise).
  try {
    if (await teslaConfigured()) {
      const tok = await getToken("tesla");
      if (tok?.system_id) {
        const live = await getLiveStatus(tok.system_id);

        if (typeof live.load_power === "number") {
          base.snapshot.home_w = Math.round(live.load_power);
          sources.home = { provider: "tesla", status: "live" };
        }
        if (typeof live.percentage_charged === "number") {
          base.snapshot.pw_soc = Math.round(live.percentage_charged);
        }
        // backup_reserve_percent isn't in live_status; pull from site_info.
        // Cached 5 min upstream so this isn't a per-tick cost.
        try {
          const info = await getSiteInfo(tok.system_id);
          if (typeof info.backup_reserve_percent === "number") {
            base.snapshot.pw_reserve = Math.round(info.backup_reserve_percent);
          }
        } catch (err) {
          console.error("[status] Tesla site_info failed:", err);
        }
        if (typeof live.battery_power === "number") {
          base.snapshot.pw_w = Math.round(live.battery_power);
        }
        if (typeof live.default_real_mode === "string") {
          // Tesla mode codes → user-friendly labels matching their app.
          base.snapshot.pw_mode =
            live.default_real_mode === "self_consumption"
              ? "Self-powered"
              : live.default_real_mode === "backup"
                ? "Backup-only"
                : live.default_real_mode === "autonomous"
                  ? "Time-based control"
                  : live.default_real_mode;
        }
        if (typeof live.grid_power === "number") {
          base.snapshot.grid_w = Math.round(live.grid_power);
          base.snapshot.grid_direction = liveGridDirection(live.grid_power);
        }
        sources.powerwall = { provider: "tesla", status: "live" };

        // Tesla solar_power is now the primary (was a fallback when
        // Enphase was the source — see comment above the Tesla block
        // for why we swapped). Always overwrite if Tesla provides a
        // number; conservation-of-energy across all four flows holds
        // only when they're sampled together.
        if (typeof live.solar_power === "number") {
          base.snapshot.solar_w = Math.round(live.solar_power);
          sources.solar = { provider: "tesla", status: "live" };
        }

        // Wall Connector — the same live_status call that gave us
        // Powerwall data also includes residential WC state inline,
        // for free. wall_connector_power is in kW; idle reads ≈ -0.01
        // (measurement noise around zero) so we clamp negatives to 0
        // and use a 100W threshold to derive ev_charging. Tesla's
        // state codes shift across firmware versions, so power
        // magnitude is the most reliable signal. Tesla cloud doesn't
        // know SoC or range — those still come from Smartcar (or
        // Rivian, when wired).
        const wcs = live.wall_connectors;
        if (Array.isArray(wcs) && wcs[0]) {
          const wc = wcs[0];
          // Tesla Fleet API reports wall_connector_power in WATTS,
          // matching solar_power / load_power / battery_power /
          // grid_power. Idle reads ~-0.01 W (noise floor); active
          // charging reads thousands of W. Earlier code mistakenly
          // multiplied by 1000 — fine when idle (negative noise was
          // clamped to 0), wildly wrong when charging (showed 6 MW
          // for a 6 kW draw). Dropped the multiplier.
          const power_w = Math.round(wc.wall_connector_power ?? 0);
          base.snapshot.ev_w = Math.max(0, power_w);
          base.snapshot.ev_charging = power_w > 100;
          // Plug-in heuristic from the WC alone: idle-with-plug reads
          // ~-0.01 W noise floor; fully unplugged reports clean 0 W
          // and state code 0/1. Either signal qualifies. Rivian
          // overlay below overrides with its cleaner chargerStatus
          // when connected — UNLESS we're observing physical current
          // (see wcObservedCurrent gating in the Rivian block).
          base.snapshot.ev_plugged_in =
            Math.abs(power_w) > 5 || (wc.wall_connector_state ?? 0) >= 2;
          // Hard signal: > 100 W flowing at the WC means the cable IS
          // connected and current IS reaching the car. No API can be
          // more authoritative than this — current can't lie about
          // its own existence.
          wcObservedCurrent = power_w > 100;
          sources.vehicle = { provider: "tesla", status: "live" };
        }
      }
    }
  } catch (err) {
    // Tesla owns solar + home + powerwall + (some of) vehicle. Demote
    // every Tesla-owned domain that didn't already make it to "live"
    // before the throw. A partial overlay (e.g. home_w succeeded then
    // grid_power threw) keeps the live flags it earned and only flags
    // the rest as unavailable. Engine + dashboard then know exactly
    // which fields are trustworthy.
    console.error("[status] Tesla overlay failed:", err);
    markUnavailable("tesla", ["solar", "home", "powerwall", "vehicle"]);
  }

  // --- Smartcar overlay: ev_soc + ev_range (car-side data only) -------
  // SoC and range are car-side data the charger can't see, so Smartcar
  // (or Rivian when wired) is authoritative for those. The charging
  // state and wattage, by contrast, come from Tesla's WC overlay above
  // — closer to ground truth than Smartcar's polled boolean. We only
  // fall back to Smartcar's charging fields if Tesla didn't supply
  // them (Tesla unconfigured, no WC linked, etc).
  try {
    if (await smartcarConfigured()) {
      const ev = await getEvSnapshot();
      if (ev) {
        base.snapshot.ev_soc = ev.soc;
        base.snapshot.ev_range = ev.rangeMiles;
        // Only own the `vehicle` source if Tesla didn't already provide
        // it. Tesla WC observes the actual current flow and is faster
        // and more accurate than Smartcar's polled boolean.
        if (sources.vehicle.provider !== "tesla") {
          base.snapshot.ev_charging = ev.isCharging;
          // If car is plugged in but not charging, ev_w should reflect 0
          // even if mock said 5.8 kW. If charging, leave the mock load
          // figure (a flat 5.8 kW estimate is close enough for the budget
          // calc when no charger telemetry is available).
          if (!ev.isCharging) {
            base.snapshot.ev_w = 0;
          }
          sources.vehicle = { provider: "smartcar", status: "live" };
        }
      }
    }
  } catch (err) {
    console.error("[status] Smartcar overlay failed:", err);
    // Smartcar owns vehicle only when Tesla didn't already mark it live.
    // markUnavailable's iff-not-live guard handles that automatically.
    markUnavailable("smartcar", ["vehicle"]);
  }

  // --- Rivian overlay: ev_soc + ev_range from the car itself ----------
  // Rivian's unofficial GraphQL gateway gives us car-side data the
  // charger can't see. Tesla WC overlay above already owns the
  // charging-state and wattage fields (it observes the actual current
  // flow, faster than Rivian's polled state); Rivian here owns the
  // SoC and range fields. When Rivian is connected, sources.vehicle
  // upgrades from "tesla" to "rivian" to reflect that the EV picture
  // is now complete (charger telemetry + car telemetry).
  try {
    if (await rivianConfigured()) {
      const ev = await getRivianEvSnapshot();
      if (ev) {
        base.snapshot.ev_soc = ev.soc;
        base.snapshot.ev_target = ev.targetPct;
        base.snapshot.ev_range = ev.rangeMiles;
        // Plug state: Rivian's chargerStatus is the cleanest signal
        // when Rivian is healthy. But during a Rivian backend outage
        // it can return junk — and we OVERWROTE the WC's correct
        // physical-current reading with junk on 2026-05-07 overnight,
        // costing ~$3.11 in unalarmed grid imports.
        //
        // The arbitration rule: trust Rivian when it agrees with WC
        // OR when WC didn't see physical current. If WC observed
        // > 100 W flowing AND Rivian disagrees by saying unplugged,
        // trust WC. Current at the connector can't lie; an HTTP
        // response can. Log the disagreement so we can spot pattern
        // failures from the activity feed later.
        if (wcObservedCurrent && !ev.isPluggedIn) {
          console.warn(
            "[status] Rivian reports unplugged but WC observed " +
              `${base.snapshot.ev_w} W flowing — keeping WC's "plugged" reading.`,
          );
          // Leave base.snapshot.ev_plugged_in as the WC overlay set it.
        } else {
          base.snapshot.ev_plugged_in = ev.isPluggedIn;
        }
        // Only adopt Rivian's charging boolean if Tesla WC didn't
        // already supply one — WC is faster and observes the actual
        // contactor, not a state code that lags by ~30s.
        if (sources.vehicle.provider !== "tesla") {
          base.snapshot.ev_charging = ev.isCharging;
        }
        // GNSS location: Rivian's onboard GNSS is currently the only
        // source. When present, plumb through so decideEvCharge's
        // geofence gate can consult it. Optional — older accounts
        // or vehicles in deep sleep may not return coordinates.
        if (typeof ev.lat === "number" && typeof ev.lng === "number") {
          base.snapshot.ev_lat = ev.lat;
          base.snapshot.ev_lng = ev.lng;
          base.snapshot.ev_location_at = ev.locationAt;
        }
        // Rivian provides the most complete car-side picture (SoC +
        // range + target + plug). Tag it live regardless of whether
        // Tesla WC also marked the domain live earlier — Rivian's
        // overlay strictly improves the data.
        sources.vehicle = { provider: "rivian", status: "live" };
      }
    }
  } catch (err) {
    console.error("[status] Rivian overlay failed:", err);
    // If Tesla WC already marked vehicle "live", we keep that — markUnavailable
    // is a no-op for live domains. If only Rivian was meant to fill vehicle
    // and it failed, the domain flips to unavailable.
    markUnavailable("rivian", ["vehicle"]);
  }

  // Note: a separate /api/ingest/wall-connector path exists (table,
  // endpoint, scripts/wc-poller.ts) for ingesting local WC vitals
  // pushed from a home agent. With Tesla cloud WC data now flowing
  // through the same live_status call we already make for Powerwall,
  // that path is dormant by default. Re-enable by importing
  // getWallConnectorSnapshot from "./wallconnector" and adding an
  // overlay block here that overrides ev_w/ev_charging when the
  // poller is running — useful for higher-frequency telemetry.

  // Derived-field assembly errors. Each catch below pushes a tag here
  // when its compute path throws; the dashboard health pill aggregates
  // these with the `sources` map to render a single trust signal. Empty
  // list at the end means a clean rollup pass.
  const assembly_errors: string[] = [];

  // --- Hero metric: today's self-sufficiency (real, not mock) --------
  // Integrates the energy_snapshots table since PT midnight. Replaces
  // the hardcoded mock value carried through from mock.ts. Adds one DB
  // query per assembleStatus call — sub-millisecond on the ~288-row
  // daily aggregate, fine for the dashboard's poll cadence.
  try {
    base.snapshot.self_sufficiency = await getSelfSufficiencyTodayPct();
  } catch (err) {
    console.error("[status] Self-sufficiency calc failed:", err);
    assembly_errors.push("self_sufficiency");
  }

  // --- EV source split: solar/grid mix for today's charging ----------
  // Same idea as the self-sufficiency calc but EV-only — what powered
  // the car's charging energy today. Replaces mock.ts's frozen 88/12.
  try {
    base.snapshot.ev_source = await getEvSourceTodaySplit();
  } catch (err) {
    console.error("[status] EV source split calc failed:", err);
    assembly_errors.push("ev_source_split");
  }

  // --- EV total kWh delivered today ----------------------------------
  // Absolute energy counterpart to ev_source's percentages. Surfaced
  // in EVCard as a "Today, so far" stat parallel to SolarCard's.
  try {
    base.snapshot.ev_charged_today_kwh = await getEvChargedTodayKwh();
  } catch (err) {
    console.error("[status] EV charged-today calc failed:", err);
    assembly_errors.push("ev_charged_today");
  }

  // --- Learned home curve: rolling 30d hour-of-day avg of home_w ----
  // Replaces the static synthetic curve in mock.ts when we have at
  // least 7 days of full-coverage history. Personalizes the EV
  // budget calc (decideEvCharge.ts uses this directly) and the
  // ForecastCard demand overlay. Falls back silently to the static
  // curve when there's not enough data, when any hour bucket is
  // sparse, or when the DB is unreachable — never blocks the
  // status path. (Not flagged as an assembly_error because the
  // static fallback is documented + safe; consumers explicitly
  // handle the synthetic-curve case.)
  try {
    const learned = await getLearnedHomeCurve();
    if (learned) base.home_curve = learned;
  } catch (err) {
    console.error("[status] Learned home curve failed, keeping static:", err);
  }

  // --- TOU rate + costs: derived from PG&E E-TOU-C schedule + grid flows ---
  // tou_period and tou_rate come from a clock+schedule lookup (no API
  // call — PG&E doesn't expose tariff data publicly and E-TOU-C is a
  // simple 4-9 PM peak block, year-round). daily/week/month_cost
  // integrate per-snapshot grid imports × the rate active at each
  // snapshot's captured_at, MINUS exports × the flat NEM export rate
  // — so a day with net export credit reads as a negative number.
  const liveRate = getRateAt(new Date());
  base.snapshot.tou_period = liveRate.period;
  base.snapshot.tou_rate = liveRate.rate;
  try {
    const config = await getConfig();
    const exportRate = config.nem_export_rate_per_kwh;
    const [today, week, month, todayExport] = await Promise.all([
      getGridCostUsd("today", exportRate),
      getGridCostUsd("week", exportRate),
      getGridCostUsd("month", exportRate),
      getGridExportKwh("today"),
    ]);
    base.snapshot.daily_cost = today;
    base.snapshot.week_cost = week;
    base.snapshot.month_cost = month;
    base.snapshot.daily_export_kwh = todayExport;
    // Stamp the NEM rate onto the snapshot so the CostCard can render
    // a direction-aware rate chip without a second config fetch.
    base.snapshot.nem_export_rate = exportRate;
  } catch (err) {
    console.error("[status] Cost calc failed:", err);
    assembly_errors.push("costs");
  }

  // --- status_word: derived from current snapshot, not mock --------
  // The headline word at the top of HeroCard. Picks the most
  // informative descriptor of the moment in priority order:
  //   alerts/errors > grid activity > active control > equilibrium.
  // Replaces mock.ts's permanent "Optimized".
  base.snapshot.status_word = deriveStatusWord(base.snapshot);

  return {
    ...base,
    sources,
    // Omit the field entirely when nothing failed — keeps the wire
    // payload tidy for the common happy path and lets consumers use
    // a simple truthy-length check.
    ...(assembly_errors.length > 0 ? { assembly_errors } : {}),
  };
}

function deriveStatusWord(snap: StatusResponse["snapshot"]): string {
  const grid_kw = snap.grid_w / 1000;
  if (grid_kw > 0.1) return "Importing";
  if (grid_kw < -0.1) return "Exporting";
  if (snap.ev_charging) {
    // Distinguish solar-powered charging from PW-discharging-to-EV —
    // both are "on-site" but the user reads them differently.
    if (snap.solar_w > snap.home_w + 200) return "Charging from sun";
    if (snap.pw_w > 200) return "Charging from PW";
    return "Charging";
  }
  if (snap.pw_w > 200) return "Powerwall covering home";
  if (snap.pw_w < -200) return "Powerwall storing";
  if (snap.solar_w > snap.home_w + 200) return "Solar surplus";
  return "Optimized";
}

function liveGridDirection(grid_w: number): GridDirection {
  if (Math.abs(grid_w) < 50) return "idle";
  return grid_w > 0 ? "import" : "export";
}
