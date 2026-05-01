// Test 2 of the live-test sequence: setChargeLimit at-or-below current SoC.
//
// Run AFTER Test 1 (test-rivian-stop.ts) has produced its result.
// Reads current SoC from /api/status, then calls setChargeLimit(socFloor)
// where socFloor is the next CHARGING_LIMITS-valid value at or below
// current. The Rivian app's limit slider has 5% granularity historically;
// the API accepts 50..100 in 1% steps per the bretterer reference.
//
// Run: cd app && npx tsx scripts/test-rivian-set-limit.ts
//
// Note: this mutates the user's profile-level charge limit. The limit
// will auto-revert overnight per the third Rivian autonomous behavior
// (4/30 postmortem). That's expected, not a bug.

import { setChargeLimit, isCommandEnrolled } from "@/lib/rivian";

const HELIOS_BASE = process.env.HELIOS_BASE ?? "http://localhost:3000";

async function readSoc(): Promise<number> {
  const r = await fetch(`${HELIOS_BASE}/api/status`);
  if (!r.ok) throw new Error(`status fetch ${r.status}`);
  const j = (await r.json()) as { snapshot: { ev_soc: number } };
  return j.snapshot.ev_soc;
}

async function main() {
  console.log("---");
  console.log("Rivian v5 setChargeLimit live test (Test 2)");
  console.log("---");

  const enrolled = await isCommandEnrolled();
  console.log("isCommandEnrolled:", enrolled);
  if (!enrolled) {
    console.error("Not enrolled. Run enrollment first.");
    process.exit(1);
  }

  const soc = await readSoc();
  console.log("Current SoC:", soc, "%");

  // Floor to nearest 5% for compatibility with Rivian app's slider, then
  // clamp to the API's valid range [50, 100]. setChargeLimit() also
  // clamps internally.
  const target = Math.max(50, Math.min(100, Math.floor(soc / 5) * 5));
  console.log("Target limit:", target, "% (floor-5% of SoC)");

  console.log("Calling setChargeLimit(", target, ")...");
  const t0 = Date.now();
  const result = await setChargeLimit(target);
  const elapsedMs = Date.now() - t0;

  console.log("---");
  console.log("Result after", elapsedMs, "ms:");
  console.log(JSON.stringify(result, null, 2));
  console.log("---");

  if (result.success) {
    console.log(
      "Verify: open the Rivian app and confirm the charge limit shows",
      target,
      "%.",
    );
    console.log(
      "Verify: car should NOT auto-resume charging (it's at-or-above limit).",
    );
  } else {
    console.log("setChargeLimit did NOT succeed. Reason:", result.reason);
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
