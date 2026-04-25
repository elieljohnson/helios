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
import type { StatusResponse } from "./types";

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

  return { ...base, sources };
}
