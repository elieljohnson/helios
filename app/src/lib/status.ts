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
  isConfigured as teslaConfigured,
  getLiveStatus,
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
        if (typeof live.backup_reserve_percent === "number") {
          base.snapshot.pw_reserve = Math.round(live.backup_reserve_percent);
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
      }
    }
  } catch (err) {
    console.error("[status] Tesla overlay failed, keeping mock:", err);
  }

  return { ...base, sources };
}

function liveGridDirection(grid_w: number): GridDirection {
  if (Math.abs(grid_w) < 50) return "idle";
  return grid_w > 0 ? "import" : "export";
}
