// Probe Smartcar V3 vehicle endpoints to discover the right paths.
//
// Why: Smartcar's dashboard groups signals under labels like "Charging
// status" and "EV battery level", but those aren't the URL slugs. The
// gateway returns INVALID_PATH for every guess so far. This script
// fires a bunch of plausible paths and prints which return 200.
//
// Run with:
//   node --env-file=.env.local --import tsx scripts/smartcar-probe.ts

import { getApplicationToken } from "../src/lib/smartcar/auth";
import { getToken } from "../src/lib/db";

const VEHICLE_API_BASE = "https://vehicle.api.smartcar.com/v3";

// Path templates to probe. {id} is substituted at runtime.
// Mix of every guess we have for the EV/charge data endpoints.
const PATHS = [
  // Original V2-style verbs
  "/vehicles/{id}",
  "/vehicles/{id}/battery",
  "/vehicles/{id}/charge",
  "/vehicles/{id}/info",

  // Kebab-case dashboard-button-label slugs (already known broken, kept for confirmation)
  "/vehicles/{id}/charging-status",
  "/vehicles/{id}/ev-battery-level",

  // Per-signal slugs
  "/vehicles/{id}/state-of-charge",
  "/vehicles/{id}/is-charging",
  "/vehicles/{id}/is-charging-cable-connected",
  "/vehicles/{id}/range",
  "/vehicles/{id}/wattage",
  "/vehicles/{id}/energy-added",

  // Signals namespace (V3 docs hint)
  "/vehicles/{id}/signals",
  "/vehicles/{id}/signals/state-of-charge",
  "/vehicles/{id}/signals/StateOfCharge",
  "/vehicles/{id}/signals/Charge.StateOfCharge",
  "/vehicles/{id}/signals/TractionBattery.StateOfCharge",
  "/vehicles/{id}/signals/charging-status",
  "/vehicles/{id}/signals/IsCharging",

  // EV namespace
  "/vehicles/{id}/ev",
  "/vehicles/{id}/ev/battery",
  "/vehicles/{id}/ev/charge",

  // Connection-scoped
  "/connections/{conn}/vehicle",
  "/connections/{conn}/signals/state-of-charge",
];

async function main(): Promise<void> {
  const tok = await getToken("smartcar");
  if (!tok) throw new Error("No smartcar token row in db; connect first.");
  const userId = tok.access_token; // column-as-credential
  const vehicleId = tok.system_id ?? "";
  const connId = (tok.meta as { connection_id?: string } | null)?.connection_id ?? "";
  if (!vehicleId) throw new Error("No vehicle pinned");

  const appToken = await getApplicationToken();
  console.log(`vehicleId=${vehicleId}`);
  console.log(`userId=${userId}`);

  for (const tpl of PATHS) {
    const path = tpl.replace("{id}", vehicleId).replace("{conn}", connId);
    const url = `${VEHICLE_API_BASE}${path}`;
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${appToken}`,
          Accept: "application/json",
          "sc-user-id": userId,
        },
      });
      const body = await res.text();
      const sample = body.length > 200 ? body.slice(0, 200) + "…" : body;
      const tag = res.ok ? "✅" : res.status === 404 ? "❌" : "⚠️ ";
      console.log(`${tag} ${res.status}  ${tpl}  ${sample}`);
    } catch (err) {
      console.log(`💥 ERR    ${tpl}  ${(err as Error).message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
