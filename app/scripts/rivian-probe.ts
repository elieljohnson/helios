// Rivian unofficial API end-to-end probe.
//
// Runs the full happy-path against your real R1S, no DB writes:
//   1. createCsrfToken
//   2. login (non-MFA)
//   3. getCurrentUser → enumerate vehicles
//   4. vehicleState(id) for the first vehicle
//   5. Map to the snapshot shape Helios consumes (soc, range,
//      isCharging, isPluggedIn).
//
// Reads creds from env so they don't end up in shell history:
//   RIVIAN_EMAIL=you@example.com
//   RIVIAN_PASSWORD=<your password>
//
// Run:
//   node --env-file=.env.local --import tsx scripts/rivian-probe.ts
//
// (Add RIVIAN_EMAIL / RIVIAN_PASSWORD to .env.local first; .env.local
// is gitignored so they won't leak. We never write the password to
// disk anywhere except your local .env.local.)

import {
  RIVIAN_CLIENT_NAME,
  RIVIAN_GATEWAY_URL,
  RIVIAN_USER_AGENT,
  createCsrfTokens,
  login,
} from "../src/lib/rivian/auth";

const VEHICLE_STATE_QUERY = `query GetVehicleState($vehicleID: String!) {
  vehicleState(id: $vehicleID) {
    __typename
    batteryLevel { __typename timeStamp value }
    distanceToEmpty { __typename timeStamp value }
    chargerState { __typename timeStamp value }
    chargerStatus { __typename timeStamp value }
  }
}`;

const CURRENT_USER_QUERY = `query CurrentUserForLogin {
  currentUser {
    __typename id email firstName lastName
    vehicles { id vin vehicle { model modelYear } }
  }
}`;

void (async () => {
  const email = process.env.RIVIAN_EMAIL;
  const password = process.env.RIVIAN_PASSWORD;
  if (!email || !password) {
    console.error("RIVIAN_EMAIL and RIVIAN_PASSWORD required in env.");
    console.error("Add to .env.local (gitignored) and re-run.");
    process.exit(1);
  }

  // Step 1
  console.log("→ createCsrfToken");
  const csrf = await createCsrfTokens();
  console.log(`  csrfToken: ${csrf.csrfToken.slice(0, 12)}…`);
  console.log(`  appSessionToken: ${csrf.appSessionToken.slice(0, 12)}…`);

  // Step 2
  console.log("\n→ Login (non-MFA)");
  const result = await login({ email, password, csrf });
  if ("otpToken" in result) {
    console.error("  MFA required. Helios doesn't yet support OTP screens.");
    console.error("  Disable 2FA temporarily, or implement the OTP step.");
    process.exit(1);
  }
  console.log(`  accessToken:      ${result.accessToken.slice(0, 12)}…`);
  console.log(`  refreshToken:     ${result.refreshToken.slice(0, 12)}…`);
  console.log(`  userSessionToken: ${result.userSessionToken.slice(0, 12)}…`);

  // Headers we'll use for every authed call
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "apollographql-client-name": RIVIAN_CLIENT_NAME,
    "user-agent": RIVIAN_USER_AGENT,
    "a-sess": csrf.appSessionToken,
    "u-sess": result.userSessionToken,
    "csrf-token": csrf.csrfToken,
  };

  // Step 3
  console.log("\n→ CurrentUserForLogin");
  const userRes = await fetch(RIVIAN_GATEWAY_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      operationName: "CurrentUserForLogin",
      query: CURRENT_USER_QUERY,
      variables: {},
    }),
  });
  const userText = await userRes.text();
  if (!userRes.ok) {
    console.error(`  HTTP ${userRes.status}: ${userText.slice(0, 300)}`);
    process.exit(1);
  }
  const userJson = JSON.parse(userText) as {
    data?: {
      currentUser: {
        firstName: string;
        lastName: string;
        email: string;
        vehicles: Array<{
          id: string;
          vin: string;
          vehicle: { model: string; modelYear: number };
        }>;
      };
    };
    errors?: Array<{ message: string }>;
  };
  if (userJson.errors?.length) {
    console.error(`  GQL errors: ${userJson.errors.map((e) => e.message).join("; ")}`);
    process.exit(1);
  }
  const u = userJson.data!.currentUser;
  console.log(`  user: ${u.firstName} ${u.lastName} <${u.email}>`);
  console.log(`  vehicles: ${u.vehicles.length}`);
  for (const v of u.vehicles) {
    console.log(`    • ${v.vehicle.modelYear} ${v.vehicle.model}  vin=${v.vin}  id=${v.id}`);
  }
  if (!u.vehicles[0]) {
    console.error("  no vehicles found on this account");
    process.exit(1);
  }
  const vehicleId = u.vehicles[0].id;

  // Step 4
  console.log(`\n→ GetVehicleState(${vehicleId})`);
  const vsRes = await fetch(RIVIAN_GATEWAY_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      operationName: "GetVehicleState",
      query: VEHICLE_STATE_QUERY,
      variables: { vehicleID: vehicleId },
    }),
  });
  const vsText = await vsRes.text();
  if (!vsRes.ok) {
    console.error(`  HTTP ${vsRes.status}: ${vsText.slice(0, 300)}`);
    process.exit(1);
  }
  const vsJson = JSON.parse(vsText) as {
    data?: {
      vehicleState: {
        batteryLevel: { value: number; timeStamp: string };
        distanceToEmpty: { value: number; timeStamp: string };
        chargerState: { value: string; timeStamp: string };
        chargerStatus: { value: string; timeStamp: string };
      };
    };
    errors?: Array<{ message: string }>;
  };
  if (vsJson.errors?.length) {
    console.error(`  GQL errors: ${vsJson.errors.map((e) => e.message).join("; ")}`);
    process.exit(1);
  }
  const s = vsJson.data!.vehicleState;
  console.log(`  batteryLevel:    ${s.batteryLevel.value.toFixed(2)}%  (ts=${s.batteryLevel.timeStamp})`);
  console.log(`  distanceToEmpty: ${s.distanceToEmpty.value} mi  (ts=${s.distanceToEmpty.timeStamp})`);
  console.log(`  chargerState:    "${s.chargerState.value}"`);
  console.log(`  chargerStatus:   "${s.chargerStatus.value}"`);

  // Step 5: snapshot shape
  console.log("\n→ Snapshot shape Helios will consume:");
  console.log({
    soc: Math.floor(s.batteryLevel.value),
    rangeMiles: Math.floor(s.distanceToEmpty.value),
    isCharging: s.chargerState.value === "charging_active",
    isPluggedIn:
      s.chargerStatus.value === "chrgr_sts_connected_charging" ||
      s.chargerStatus.value === "chrgr_sts_connected_no_chrg" ||
      s.chargerStatus.value === "chrgr_sts_connected_chrg_complete",
  });
  console.log("\n✅ end-to-end probe succeeded");
})();
