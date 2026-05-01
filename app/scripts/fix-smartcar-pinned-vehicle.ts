// One-shot: re-pin Smartcar's vehicle to the first LIVE vehicle on
// the connection, in case the row got pointed at a simulated one.
//
// Run: cd app && npx tsx --env-file=.env.local scripts/fix-smartcar-pinned-vehicle.ts

import { listVehicleIds, pinVehicleId, getEvSnapshot } from "@/lib/smartcar";

async function main() {
  const ids = await listVehicleIds();
  console.log("Live-mode vehicle IDs from /v3/connections:", ids);

  if (ids.length === 0) {
    console.error("No live-mode connections — nothing to pin.");
    process.exit(1);
  }

  await pinVehicleId(ids[0]);
  console.log("Pinned:", ids[0]);

  console.log("Reading getEvSnapshot()...");
  const ev = await getEvSnapshot();
  console.log("Snapshot:", JSON.stringify(ev, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
