// Snapshot assembly. Starts from the validated "optimized" mock and lets
// each connected provider overlay its real data. Today: Enphase replaces
// `solar_w`. Tomorrow: Tesla overlays the PW fields, Smartcar overlays
// the EV fields. The shape returned is unchanged — every consumer
// (status route, cron tick, preview-decision) keeps working the same.
//
// Failures from any provider degrade to the mock value rather than
// breaking the request. A `sources` field is attached so the UI can
// distinguish real vs. mocked fields without a second round-trip.

import { getToken } from "./db";
import {
  isConfigured as enphaseConfigured,
  getConsumptionPower,
  getSummary,
} from "./enphase";
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
import type { GridDirection, StatusResponse } from "./types";

export type AssembledStatus = StatusResponse & {
  sources: NonNullable<StatusResponse["sources"]>;
};

export async function assembleStatus(): Promise<AssembledStatus> {
  const base = mockStatus();
  base.timestamp = new Date().toISOString();

  const sources: AssembledStatus["sources"] = {
    solar: "mock",
    home: "mock",
    powerwall: "mock",
    vehicle: "mock",
  };

  // --- Enphase overlay: solar_w via /summary, home_w via /telemetry ---
  try {
    if (await enphaseConfigured()) {
      const tok = await getToken("enphase");
      if (tok?.system_id) {
        // Solar — instantaneous current_power from /summary.
        try {
          const summary = await getSummary(tok.system_id);
          if (typeof summary.current_power === "number") {
            base.snapshot.solar_w = Math.round(summary.current_power);
            sources.solar = "enphase";
          }
        } catch (err) {
          console.error("[status] Enphase summary failed:", err);
        }

        // Home — average watts over the latest 15-min consumption interval.
        // Independent try-block so a flaky telemetry call doesn't kill the
        // solar overlay.
        try {
          const homeW = await getConsumptionPower(tok.system_id);
          if (homeW != null) {
            base.snapshot.home_w = homeW;
            sources.home = "enphase";
          }
        } catch (err) {
          console.error("[status] Enphase consumption failed:", err);
        }
      }
    }
  } catch (err) {
    console.error("[status] Enphase overlay failed, keeping mock:", err);
  }

  // --- Tesla overlay: home_w (load_power), pw_*, grid_w, plus solar ----
  // Tesla's load_power is authoritative for home consumption, so it
  // takes precedence over Enphase consumption (which is null on this
  // hardware anyway). Solar from Tesla is left subordinate to Enphase
  // since the IQ8X micros are the actual production source of truth.
  try {
    if (await teslaConfigured()) {
      const tok = await getToken("tesla");
      if (tok?.system_id) {
        const live = await getLiveStatus(tok.system_id);

        if (typeof live.load_power === "number") {
          base.snapshot.home_w = Math.round(live.load_power);
          sources.home = "tesla";
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
        if (typeof live.grid_power === "number") {
          base.snapshot.grid_w = Math.round(live.grid_power);
          base.snapshot.grid_direction = liveGridDirection(live.grid_power);
        }
        sources.powerwall = "tesla";

        // If Enphase didn't already supply solar (e.g., not configured),
        // fall back to Tesla's solar_power reading so the snapshot is
        // self-consistent.
        if (sources.solar === "mock" && typeof live.solar_power === "number") {
          base.snapshot.solar_w = Math.round(live.solar_power);
          sources.solar = "tesla";
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
          const power_w = Math.round((wcs[0].wall_connector_power ?? 0) * 1000);
          base.snapshot.ev_w = Math.max(0, power_w);
          base.snapshot.ev_charging = power_w > 100;
          sources.vehicle = "tesla";
        }
      }
    }
  } catch (err) {
    console.error("[status] Tesla overlay failed, keeping mock:", err);
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
        if (sources.vehicle !== "tesla") {
          base.snapshot.ev_charging = ev.isCharging;
          // If car is plugged in but not charging, ev_w should reflect 0
          // even if mock said 5.8 kW. If charging, leave the mock load
          // figure (a flat 5.8 kW estimate is close enough for the budget
          // calc when no charger telemetry is available).
          if (!ev.isCharging) {
            base.snapshot.ev_w = 0;
          }
          sources.vehicle = "smartcar";
        }
      }
    }
  } catch (err) {
    console.error("[status] Smartcar overlay failed, keeping mock:", err);
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
        base.snapshot.ev_range = ev.rangeMiles;
        // Only adopt Rivian's charging boolean if Tesla WC didn't
        // already supply one — WC is faster and observes the actual
        // contactor, not a state code that lags by ~30s.
        if (sources.vehicle !== "tesla") {
          base.snapshot.ev_charging = ev.isCharging;
        }
        sources.vehicle = "rivian";
      }
    }
  } catch (err) {
    console.error("[status] Rivian overlay failed, keeping prior:", err);
  }

  // Note: a separate /api/ingest/wall-connector path exists (table,
  // endpoint, scripts/wc-poller.ts) for ingesting local WC vitals
  // pushed from a home agent. With Tesla cloud WC data now flowing
  // through the same live_status call we already make for Powerwall,
  // that path is dormant by default. Re-enable by importing
  // getWallConnectorSnapshot from "./wallconnector" and adding an
  // overlay block here that overrides ev_w/ev_charging when the
  // poller is running — useful for higher-frequency telemetry.

  return { ...base, sources };
}

function liveGridDirection(grid_w: number): GridDirection {
  if (Math.abs(grid_w) < 50) return "idle";
  return grid_w > 0 ? "import" : "export";
}
