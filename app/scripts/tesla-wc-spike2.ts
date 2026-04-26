// Tesla Fleet API → Wall Connector spike, take 2.
//
// First spike revealed the WC is nested in
//   products[0].components.wall_connectors[]
// not a top-level product. Both device_id (UUID) and din (Tesla device
// identification number) are exposed. Probing the most likely live
// data paths now, focused on what's actually plausible.
//
//   node --env-file=.env.local --import tsx scripts/tesla-wc-spike2.ts

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
  const tag = status === 200 ? "✅" : status === 404 ? "❌" : status === 403 ? "🔒" : "⚠️ ";
  console.log(`${tag} ${status}  ${label}`);
  console.log(`     ${path}`);
  console.log(`     ${body.slice(0, 400)}\n`);
}

async function main(): Promise<void> {
  const products = await listProducts();
  const site = products[0] as unknown as Record<string, unknown>;
  const components = site.components as Record<string, unknown>;
  const wcs = components.wall_connectors as Array<Record<string, unknown>>;
  const wc = wcs[0];

  const siteId = site.energy_site_id as number;
  const deviceId = wc.device_id as string;
  const din = wc.din as string;
  const serial = wc.serial_number as string;

  console.log(`Site: ${siteId}  WC.device_id: ${deviceId}  WC.din: ${din}\n`);

  console.log("=== Wall Connector live data probes ===\n");

  // Site-level live_status — Tesla may include WC arrays here
  await probe("site live_status (may include WC data inline)", `/api/1/energy_sites/${siteId}/live_status`);

  // Site-scoped WC paths (most idiomatic per Tesla's URL hierarchy)
  await probe("site/wall_connectors", `/api/1/energy_sites/${siteId}/wall_connectors`);
  await probe("site/wall_connectors/{device_id}", `/api/1/energy_sites/${siteId}/wall_connectors/${deviceId}`);
  await probe("site/wall_connectors/{device_id}/live_status", `/api/1/energy_sites/${siteId}/wall_connectors/${deviceId}/live_status`);
  await probe("site/wall_connectors/{din}/live_status", `/api/1/energy_sites/${siteId}/wall_connectors/${encodeURIComponent(din)}/live_status`);

  // Top-level WC paths
  await probe("wall_connectors/{device_id}", `/api/1/wall_connectors/${deviceId}`);
  await probe("wall_connectors/{device_id}/live_status", `/api/1/wall_connectors/${deviceId}/live_status`);
  await probe("wall_connectors/{din}", `/api/1/wall_connectors/${encodeURIComponent(din)}`);
  await probe("wall_connectors/{din}/live_status", `/api/1/wall_connectors/${encodeURIComponent(din)}/live_status`);
  await probe("wall_connectors/{serial}/live_status", `/api/1/wall_connectors/${serial}/live_status`);

  // Products-scoped
  await probe("products/{device_id}", `/api/1/products/${deviceId}`);
  await probe("products/{din}", `/api/1/products/${encodeURIComponent(din)}`);

  // Historical telemetry (the one path the docs actually mention)
  const start = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const end = new Date().toISOString();
  await probe(
    "site/telemetry_history kind=charge (24h)",
    `/api/1/energy_sites/${siteId}/telemetry_history?kind=charge&start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}&time_zone=America%2FLos_Angeles`,
  );

  // Local ground truth
  console.log("=== Local /api/1/vitals (ground truth this moment) ===");
  try {
    const r = await fetch(`http://${WC_LOCAL_IP}/api/1/vitals`, {
      signal: AbortSignal.timeout(5000),
    });
    const v = (await r.json()) as Record<string, unknown>;
    const current = Number(v.vehicle_current_a ?? 0);
    const volts = Number(v.grid_v ?? 0);
    console.log(`  contactor_closed=${v.contactor_closed}  vehicle_connected=${v.vehicle_connected}`);
    console.log(`  current=${current}A  volts=${volts}V → ${(current * volts).toFixed(0)}W`);
    console.log(`  session_energy_wh=${v.session_energy_wh}  evse_state=${v.evse_state}`);
  } catch (err) {
    console.log(`  ⚠️  ${(err as Error).message}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
