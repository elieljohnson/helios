// One-shot Rivian v5 STOP_CHARGING live test.
//
// Run: cd app && npx tsx scripts/test-rivian-stop.ts
//
// Pre-reqs (per docs/session-handoff.md):
//   1. Car plugged in and actively charging > 1 kW
//   2. Phone enrollment already run (POST /api/integrations/rivian/enroll)
//
// What it does: imports stopCharging from @/lib/rivian and calls it
// once. Prints the result. Does NOT poll ev_w — the watcher script
// (test-rivian-watch.ts) handles that.
//
// Test 1 of the live-test sequence: STOP_CHARGING alone (no
// setChargeLimit). Clean attribution per the belt-and-suspenders
// decision documented in session-handoff.md.

import { stopCharging, isCommandEnrolled } from "@/lib/rivian";

async function main() {
  console.log("---");
  console.log("Rivian v5 STOP_CHARGING live test");
  console.log("---");

  const enrolled = await isCommandEnrolled();
  console.log("isCommandEnrolled:", enrolled);
  if (!enrolled) {
    console.error(
      "Not enrolled. Run POST /api/integrations/rivian/enroll first.",
    );
    process.exit(1);
  }

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
    console.log(
      "Expected: ev_w drops to ~0 within ~10s. If it stays above 100W,",
    );
    console.log(
      "the verification loop will catch it on the next cron tick.",
    );
  } else {
    console.log("Stop did NOT succeed. Reason:", result.reason);
    console.log("Do NOT push the v5 commits. Investigate before retrying.");
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
