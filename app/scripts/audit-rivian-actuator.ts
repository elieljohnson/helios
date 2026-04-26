// Rivian charging actuator audit. Same pattern as audit-actuator.ts
// (Powerwall): exercises the full write path with a SAFE call —
// "stop charging" via empty-schedules-array — that doesn't change
// anything if the car isn't currently charging on a Helios schedule.
//
// If Rivian responds with success: true, the actuator is verified
// end-to-end: token refresh works, CSRF is fresh, the
// setChargingSchedules mutation accepts our auth, and our schedule
// shape (or lack of one in this case) parses on Rivian's side.
//
// Run:
//   node --env-file=.env.local --import tsx scripts/audit-rivian-actuator.ts
//
// SAFETY:
//   - This issues setChargingSchedules with an EMPTY array, which
//     clears any existing charging schedules on the car.
//   - If you have manual Rivian-app schedules you care about, this
//     will wipe them. (Per the Phase 2 architecture decision: Helios
//     takes over schedules entirely; user re-creates manually if
//     they ever disconnect Helios.)

import {
  getCurrentUser,
  isConfigured,
  setChargingSchedule,
  startCharging,
  stopCharging,
} from "../src/lib/rivian";
import { getToken } from "../src/lib/db";

void (async () => {
  if (!(await isConfigured())) {
    console.error("Rivian not configured. Connect via /settings first.");
    process.exit(1);
  }
  const tok = await getToken("rivian");
  if (!tok?.system_id) {
    console.error("No vehicle pinned on the rivian token row.");
    process.exit(1);
  }
  console.log(`vehicle_id: ${tok.system_id}`);

  // Sanity ping — confirms the read path before we try a write.
  const user = await getCurrentUser();
  const v = user.vehicles.find((vv) => vv.id === tok.system_id);
  console.log(
    `vehicle:    ${v ? `${v.vehicle.modelYear} ${v.vehicle.model} (${v.vin})` : "(not in user.vehicles!)"}`,
  );

  console.log("\n--- (1) Helper: stopCharging() ---");
  const before1 = Date.now();
  const r1 = await stopCharging({ coords: { lat: 37.897029, lng: -122.539091 } });
  console.log(`Rivian returned: ${JSON.stringify(r1)} in ${Date.now() - before1}ms`);
  console.log(r1.success ? "✅ STOP PATH VERIFIED" : "❌ STOP PATH BROKEN");

  // (2) Direct mutation call with a valid sentinel — confirms the
  // low-level wrapper. Empty array is documented as INVALID_INPUT
  // (verified via scripts/rivian-stop-probe.ts).
  console.log("\n--- (2) Low-level: setChargingSchedule(<sentinel>) ---");
  const before2 = Date.now();
  const r2 = await setChargingSchedule(tok.system_id, [
    {
      weekDays: ["Monday"],
      startTime: 0,
      duration: 0,
      location: { latitude: 0, longitude: 0 },
      amperage: 0,
      enabled: false,
    },
  ]);
  console.log(`returned: ${JSON.stringify(r2)} in ${Date.now() - before2}ms`);
  console.log(r2.success ? "✅ LOW-LEVEL MUTATION VERIFIED" : "❌ LOW-LEVEL MUTATION BROKEN");

  // (3) Optional: a "start" smoke test. Uncomment to actually queue a
  //     charging window. Rivian respects geofence so the car won't
  //     start unless it's at home — but be aware this DOES write a
  //     schedule. Default: skip in audit.
  if (process.env.AUDIT_RIVIAN_START === "1") {
    console.log("\n--- (3) Helper: startCharging(rateKw=2, 0.25h) ---");
    const before3 = Date.now();
    const r3 = await startCharging({
      rateKw: 2,
      durationHours: 0.25,
      coords: { lat: 37.897029, lng: -122.539091 },
    });
    console.log(`returned: ${JSON.stringify(r3)} in ${Date.now() - before3}ms`);
    console.log(r3.success ? "✅ START HELPER VERIFIED" : "❌ START HELPER BROKEN");
    // Clean up immediately so we don't leave a stale schedule.
    await stopCharging();
    console.log("(schedules cleared after test)");
  } else {
    console.log("\n--- (3) Skipped start test (set AUDIT_RIVIAN_START=1 to run) ---");
  }
})();
