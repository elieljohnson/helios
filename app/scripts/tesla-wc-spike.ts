// Tesla Fleet API → Wall Connector telemetry spike.
//
// Question: with the user's existing energy_device_data + energy_cmds
// scopes (already authed for Powerwall), can we read the Universal
// Wall Connector's live data straight from Tesla's cloud — bypassing
// the home-LAN poller entirely?
//
// Strategy:
//   1. List products. Confirm the WC shows up (resource_type =
//      "wall_connector") and dump its full record so we know the ID
//      shape.
//   2. Probe the most likely live-data paths. Tesla's docs are sparse
//      and the HA tesla_fleet integration says Power, State, Vehicle
//      sensors exist but doesn't name the endpoint, so we sweep:
//        /api/1/wall_connectors/{id}
//        /api/1/wall_connectors/{id}/live_status
//        /api/1/wall_connectors/{din}
//        /api/1/products/{id}/live_status
//        /api/1/energy_sites/{site}/live_status (already used for PW)
//        /api/1/energy_sites/{site}/wall_connectors
//   3. Compare any live data against the local /api/1/vitals reading
//      taken at the same moment — sanity check.
//
//   node --env-file=.env.local --import tsx scripts/tesla-wc-spike.ts

import { listProducts } from "../src/lib/tesla";
import { getToken } from "../src/lib/db";
import { TESLA_API_BASE } from "../src/lib/tesla/auth";

const WC_LOCAL_IP = "192.168.5.15";

async function authedGet(path: string): Promise<{ status: number; body: string }> {
  const tok = await getToken("tesla");
  if (!tok) throw new Error("no Tesla token in DB");
  const r = await fetch(`${TESLA_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${tok.access_token}`,
      Accept: "application/json",
    },
  });
  return { status: r.status, body: await r.text() };
}

async function probe(label: string, path: string): Promise<void> {
  const { status, body } = await authedGet(path);
  const tag = status === 200 ? "✅" : status === 404 ? "❌" : "⚠️ ";
  console.log(`  ${tag} ${status}  ${label}`);
  console.log(`         ${body.slice(0, 350)}\n`);
}

async function main(): Promise<void> {
  // (1) List products
  console.log("=== (1) /api/1/products ===");
  const products = await listProducts();
  console.log(`  ${products.length} product(s) found:\n`);
  for (const p of products) {
    console.log("  • full product record:");
    console.log(JSON.stringify(p, null, 4).split("\n").map((l) => "    " + l).join("\n"));
    console.log();
  }

  // (2) Find the WC (and the energy site, for the energy_site-scoped probe)
  const wc = products.find((p) => p.resource_type === "wall_connector");
  const site = products.find((p) => p.resource_type === "battery" || p.resource_type === "solar");

  if (!wc) {
    console.log("\n❌ No wall_connector in /products. Either:");
    console.log("   - WC isn't linked to this Tesla account");
    console.log("   - Existing scopes don't surface WCs");
    console.log("   - Universal WC is registered differently");
    return;
  }

  console.log(`\n=== (2) Found wall_connector ===`);
  // Tesla uses "id" sometimes, "din" (device identification number) sometimes.
  // Print every key so we know what to thread into URL paths.
  const wcRec = wc as unknown as Record<string, unknown>;
  console.log(`  keys: ${Object.keys(wcRec).join(", ")}`);

  // Pull plausible identifiers
  const id = wcRec.id ?? wcRec.din ?? wcRec.energy_site_id;
  const din = wcRec.din;
  const siteId = site?.energy_site_id;

  console.log(`  id=${id}  din=${din}  energy_site_id=${siteId}\n`);

  // (3) Probe live-data paths
  console.log("=== (3) Live data probes ===");
  const paths: Array<[string, string]> = [];
  if (id) {
    paths.push([`WC by id`, `/api/1/wall_connectors/${id}`]);
    paths.push([`WC by id /live_status`, `/api/1/wall_connectors/${id}/live_status`]);
  }
  if (din && din !== id) {
    paths.push([`WC by din`, `/api/1/wall_connectors/${din}`]);
    paths.push([`WC by din /live_status`, `/api/1/wall_connectors/${din}/live_status`]);
  }
  if (id) {
    paths.push([`product /live_status`, `/api/1/products/${id}/live_status`]);
  }
  if (siteId) {
    paths.push([`site/live_status`, `/api/1/energy_sites/${siteId}/live_status`]);
    paths.push([`site/wall_connectors`, `/api/1/energy_sites/${siteId}/wall_connectors`]);
    paths.push([
      `site/telemetry_history kind=charge`,
      `/api/1/energy_sites/${siteId}/telemetry_history?kind=charge&start_date=${encodeURIComponent(new Date(Date.now() - 24 * 3600 * 1000).toISOString())}&end_date=${encodeURIComponent(new Date().toISOString())}&time_zone=America%2FLos_Angeles`,
    ]);
  }

  for (const [label, path] of paths) {
    await probe(label, path);
  }

  // (4) Compare to local WC for ground truth
  console.log("=== (4) Local /api/1/vitals (ground truth at this moment) ===");
  try {
    const r = await fetch(`http://${WC_LOCAL_IP}/api/1/vitals`, {
      signal: AbortSignal.timeout(5000),
    });
    const v = (await r.json()) as Record<string, unknown>;
    const current = Number(v.vehicle_current_a ?? 0);
    const volts = Number(v.grid_v ?? 0);
    console.log(`  contactor_closed=${v.contactor_closed}  vehicle_connected=${v.vehicle_connected}`);
    console.log(`  vehicle_current_a=${current}A  grid_v=${volts}V → ${(current * volts).toFixed(0)}W`);
    console.log(`  session_energy_wh=${v.session_energy_wh}  evse_state=${v.evse_state}`);
  } catch (err) {
    console.log(`  ⚠️  local probe failed: ${(err as Error).message}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
