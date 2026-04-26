// Rivian unofficial API end-to-end probe.
//
// Two-step flow because Rivian challenges every new IP with an OTP:
//
//   Run 1 (no RIVIAN_OTP set):
//     CSRF → Login. If MFA required, save state to /tmp and exit with
//     a "set RIVIAN_OTP=<code> and re-run" message. Rivian sends an
//     OTP to the user's email/SMS at this point.
//
//   Run 2 (RIVIAN_OTP=<6-digit-code> set):
//     Read saved state → submitOtp → tokens → currentUser → vehicleState.
//     Delete state file on success.
//
// Reads creds from env so they don't end up in shell history:
//   RIVIAN_EMAIL=you@example.com
//   RIVIAN_PASSWORD=<your password>
//   RIVIAN_OTP=<6-digit code from email>   (only on run 2)
//
// Run:
//   node --env-file=.env.local --import tsx scripts/rivian-probe.ts

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RIVIAN_CLIENT_NAME,
  RIVIAN_GATEWAY_URL,
  RIVIAN_USER_AGENT,
  loginFlow,
  submitOtp,
} from "../src/lib/rivian/auth";

const STATE_FILE = join(tmpdir(), "helios-rivian-probe-state.json");

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

type SavedState = {
  email: string;
  otpToken: string;
  csrfToken: string;
  appSessionToken: string;
};

async function readState(): Promise<SavedState | null> {
  try {
    const text = await fs.readFile(STATE_FILE, "utf-8");
    return JSON.parse(text) as SavedState;
  } catch {
    return null;
  }
}

async function writeState(state: SavedState): Promise<void> {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function clearState(): Promise<void> {
  try {
    await fs.unlink(STATE_FILE);
  } catch {
    // already gone, fine
  }
}

void (async () => {
  const email = process.env.RIVIAN_EMAIL;
  const password = process.env.RIVIAN_PASSWORD;
  const otpCode = process.env.RIVIAN_OTP;
  if (!email || !password) {
    console.error("RIVIAN_EMAIL and RIVIAN_PASSWORD required in env.");
    process.exit(1);
  }

  let csrfTokens: { csrfToken: string; appSessionToken: string };
  let userSessionToken: string;

  if (otpCode) {
    // ---- Run 2: complete login with OTP ----
    console.log(`→ Resuming with OTP code ${otpCode}`);
    const state = await readState();
    if (!state) {
      console.error(
        "  No saved state. Run the probe without RIVIAN_OTP first to trigger an email.",
      );
      process.exit(1);
    }
    if (state.email !== email) {
      console.error(`  State email (${state.email}) doesn't match RIVIAN_EMAIL (${email}). Clearing.`);
      await clearState();
      process.exit(1);
    }

    csrfTokens = { csrfToken: state.csrfToken, appSessionToken: state.appSessionToken };

    console.log("→ submitOtp");
    const tokens = await submitOtp({
      email,
      otpCode,
      otpToken: state.otpToken,
      csrf: csrfTokens,
    });
    userSessionToken = tokens.userSessionToken;
    console.log(`  accessToken:      ${tokens.accessToken.slice(0, 12)}…`);
    console.log(`  refreshToken:     ${tokens.refreshToken.slice(0, 12)}…`);
    console.log(`  userSessionToken: ${userSessionToken.slice(0, 12)}…`);
    await clearState();
  } else {
    // ---- Run 1: CSRF + login ----
    console.log("→ createCsrfToken + Login");
    const flow = await loginFlow({ email, password });
    csrfTokens = flow.csrf;
    if (flow.mfa) {
      // MFA path: save state, instruct user to re-run with OTP code
      await writeState({
        email,
        otpToken: flow.otpToken,
        csrfToken: csrfTokens.csrfToken,
        appSessionToken: csrfTokens.appSessionToken,
      });
      console.log(`  csrfToken: ${csrfTokens.csrfToken.slice(0, 12)}…`);
      console.log(`  otpToken:  ${flow.otpToken.slice(0, 12)}…`);
      console.log("");
      console.log("📨 Rivian just sent an OTP to your email/SMS.");
      console.log("   Set RIVIAN_OTP=<6-digit code> in .env.local and re-run:");
      console.log("     node --env-file=.env.local --import tsx scripts/rivian-probe.ts");
      console.log("");
      console.log(`   State saved to ${STATE_FILE} (auto-cleared on success).`);
      process.exit(0);
    }
    userSessionToken = flow.tokens.userSessionToken;
    console.log(`  no MFA — direct tokens received`);
    console.log(`  userSessionToken: ${userSessionToken.slice(0, 12)}…`);
  }

  // ---- Authenticated calls ----
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "apollographql-client-name": RIVIAN_CLIENT_NAME,
    "user-agent": RIVIAN_USER_AGENT,
    "a-sess": csrfTokens.appSessionToken,
    "u-sess": userSessionToken,
    "csrf-token": csrfTokens.csrfToken,
  };

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
