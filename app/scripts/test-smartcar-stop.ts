// One-shot Smartcar V3 stopCharging live test.
//
// Run: cd app && npx tsx --env-file=.env.local scripts/test-smartcar-stop.ts
//
// Pre-reqs:
//   1. Car plugged in and actively drawing > 1 kW
//   2. Smartcar reconnected via Settings → Integrations
//
// What it does: imports stopCharging from @/lib/smartcar and calls it
// once. Prints the result. Mirror of test-rivian-stop.ts.
//
// Test 1 of the belt-and-suspenders sequence: STOP alone (no
// setChargeLimit). Clean attribution per session-handoff.md.

import { stopCharging } from "@/lib/smartcar";

async function main() {
  console.log("---");
  console.log("Smartcar V3 STOP_CHARGE live test");
  console.log("---");
  console.log("Calling stopCharging()...");
  const t0 = Date.now();
  const result = await stopCharging();
  const elapsedMs = Date.now() - t0;
  console.log("---");
  console.log("Result after", elapsedMs, "ms:");
  console.log(JSON.stringify(result, null, 2));
  console.log("---");
  if (result.success) {
    console.log("API ack received. NOW WATCH ev_w in /api/status.");
    console.log("Expected: ev_w drops to ~0 within ~10s.");
  } else {
    console.log("Stop did NOT succeed.");
    console.log("Reason:", result.reason);
    console.log("Status:", result.status);
    console.log("RequestId:", result.requestId);
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
