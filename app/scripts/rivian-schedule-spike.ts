// Rivian schedule/profile-surface spike — the one untried crack.
//
// WHY THIS EXISTS (read before running):
//   Every CAR-COMMAND path to controlling the Rivian R1S Gen 2 is closed:
//   Rivian sendVehicleCommand (incl. the old command-based `setChargeLimit`,
//   commit 87d4743 → reverted 7ecb23d), Smartcar V3 commands, and local BLE
//   all hit the Apple Car Key pairing wall. See
//   docs/postmortems/2026-04-30-rivian-schedule-trap.md.
//
//   BUT the *charging-schedule* surface (SET_CHARGING_SCHEDULES_MUTATION)
//   demonstrably WRITES cloud-only WITHOUT pairing — that is exactly how the
//   4/30 trap accidentally created "permitted charge windows." The trap only
//   ever proved that `amperage: 0` is IGNORED (the car fell back to the wall
//   connector's offered current). Two things were never tested on this
//   non-command surface, and this spike tests them:
//     (1) does a schedule with a NONZERO amperage (e.g. 12 A) actually
//         throttle the car in-window?
//     (2) is there any non-command mutation that writes a charge LIMIT (a
//         limit ≤ current SoC is the user's durable manual stop today)?
//
// WHAT THIS DOES:
//   Phase 1 (READ-ONLY, safe): GraphQL introspection of the gateway's
//     mutation surface + the charging-schedule input type. Prints every
//     charge/limit/schedule/amperage-related operation and its argument
//     shape. This alone answers question (2) and tells us the exact
//     amperage field type for question (1). No car state is touched.
//   Phase 2 (WRITE, gated — DO NOT run unattended): writes a nonzero-
//     amperage schedule, reads the vehicle's live charge state back to see
//     whether it throttled, then CLEARS the schedule again. Requires the
//     env flag AND you watching the physical car. See the guard below.
//
// AUTH: fresh login (does not touch the DB, which is down locally). Rivian
//   challenges new IPs with an emailed OTP, so this is a two-step run,
//   mirroring scripts/rivian-probe.ts:
//     Run 1:  node --env-file=.env.local --import tsx scripts/rivian-schedule-spike.ts
//             → if MFA, saves state to /tmp and asks you to re-run with the code.
//     Run 2:  RIVIAN_OTP=123456 node --env-file=.env.local --import tsx scripts/rivian-schedule-spike.ts
//
//   Env: RIVIAN_EMAIL, RIVIAN_PASSWORD, [RIVIAN_OTP on run 2].
//   Phase 2 additionally requires: SPIKE_ALLOW_WRITE=yes-i-am-watching-the-car

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RIVIAN_CLIENT_NAME,
  RIVIAN_GATEWAY_URL,
  RIVIAN_USER_AGENT,
  createCsrfTokens,
  login,
  submitOtp,
} from "../src/lib/rivian/auth";
import type { RivianCsrfTokens } from "../src/lib/rivian/types";

const STATE_FILE = join(tmpdir(), "helios-rivian-schedule-spike.json");

type Sess = { uSess: string; csrf: string; aSess: string };

/** Authed GraphQL call using freshly-minted session tokens (not the DB). */
async function gql<T>(sess: Sess, operationName: string, query: string, variables: Record<string, unknown> = {}): Promise<{ data?: T; errors?: { message: string }[]; raw: string }> {
  const res = await fetch(RIVIAN_GATEWAY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "apollographql-client-name": RIVIAN_CLIENT_NAME,
      "user-agent": RIVIAN_USER_AGENT,
      "a-sess": sess.aSess,
      "u-sess": sess.uSess,
      "csrf-token": sess.csrf,
    },
    body: JSON.stringify({ operationName, query, variables }),
  });
  const raw = await res.text();
  let parsed: { data?: T; errors?: { message: string }[] } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* non-JSON — surfaced via raw */
  }
  return { ...parsed, raw };
}

// ---- Auth (two-step OTP) ---------------------------------------------------

async function authenticate(): Promise<Sess> {
  const email = process.env.RIVIAN_EMAIL;
  const password = process.env.RIVIAN_PASSWORD;
  if (!email || !password) {
    throw new Error("Set RIVIAN_EMAIL and RIVIAN_PASSWORD (via --env-file=.env.local).");
  }

  const otp = process.env.RIVIAN_OTP;
  if (otp) {
    // Run 2: read saved CSRF + otpToken, submit the code.
    const saved = JSON.parse(await fs.readFile(STATE_FILE, "utf8")) as {
      csrf: RivianCsrfTokens;
      otpToken: string;
    };
    const tokens = await submitOtp({ email, otpCode: otp, otpToken: saved.otpToken, csrf: saved.csrf });
    await fs.rm(STATE_FILE, { force: true });
    return { uSess: tokens.userSessionToken, csrf: saved.csrf.csrfToken, aSess: saved.csrf.appSessionToken };
  }

  // Run 1: CSRF + login.
  const csrf = await createCsrfTokens();
  const result = await login({ email, password, csrf });
  if ("otpToken" in result) {
    await fs.writeFile(STATE_FILE, JSON.stringify({ csrf, otpToken: result.otpToken }));
    console.log("\nMFA required. Rivian emailed a 6-digit code.");
    console.log("Re-run with the code:\n");
    console.log("  RIVIAN_OTP=123456 node --env-file=.env.local --import tsx scripts/rivian-schedule-spike.ts\n");
    process.exit(0);
  }
  return { uSess: result.userSessionToken, csrf: csrf.csrfToken, aSess: csrf.appSessionToken };
}

// ---- Phase 1: introspection (read-only) ------------------------------------

const INTROSPECT_MUTATIONS = `query SpikeMutations {
  __schema { mutationType { fields { name description args { name type { kind name ofType { kind name } } } } } }
}`;

const INTROSPECT_TYPE = `query SpikeType($name: String!) {
  __type(name: $name) { name kind inputFields { name description type { kind name ofType { kind name } } } enumValues { name } }
}`;

const RELEVANT = /charg|limit|schedul|amper|current|rate/i;

async function phase1(sess: Sess): Promise<void> {
  console.log("\n=== PHASE 1 — introspection (read-only) ===\n");
  const m = await gql<{ __schema: { mutationType: { fields: { name: string; description?: string; args: { name: string; type: unknown }[] }[] } | null } }>(
    sess,
    "SpikeMutations",
    INTROSPECT_MUTATIONS,
  );
  if (m.errors?.length || !m.data?.__schema?.mutationType) {
    console.log("Introspection appears disabled or errored:");
    console.log("  ", m.errors?.map((e) => e.message).join("; ") || m.raw.slice(0, 400));
    console.log("\nFallback: probe candidate operations by name — send a minimal");
    console.log("query for each and read the GraphQL error (it reveals whether the");
    console.log("field exists and its required args). Candidates worth probing:");
    console.log("  setVehicleChargingSchedules, setChargingSchedules, updateVehicle,");
    console.log("  setChargingLimit, setVehicleChargingLimit, chargingProfile.");
    return;
  }

  const fields = m.data.__schema.mutationType.fields;
  const hits = fields.filter((f) => RELEVANT.test(f.name) || RELEVANT.test(f.description ?? ""));
  console.log(`Gateway exposes ${fields.length} mutations; ${hits.length} charge/limit/schedule-related:\n`);
  for (const f of hits) {
    console.log(`  • ${f.name}(${f.args.map((a) => a.name).join(", ")})`);
    if (f.description) console.log(`      ${f.description}`);
  }
  if (!hits.length) {
    console.log("  (none matched — the surface may name things differently; dump all:)");
    for (const f of fields) console.log("   -", f.name);
  }

  // Inspect the charging-schedule input type for the amperage field's type,
  // and look for any charge-limit input. Type names vary; try the common ones.
  for (const typeName of ["SetChargingSchedulesInput", "ChargingScheduleInput", "VehicleChargingSchedule", "ChargingSchedule"]) {
    const t = await gql<{ __type: { name: string; inputFields?: { name: string; type: unknown }[] } | null }>(
      sess,
      "SpikeType",
      INTROSPECT_TYPE,
      { name: typeName },
    );
    if (t.data?.__type?.inputFields?.length) {
      console.log(`\nInput type ${t.data.__type.name}:`);
      for (const f of t.data.__type.inputFields) console.log("   -", f.name);
    }
  }
  console.log("\nRead the above: (a) is there a charge-LIMIT mutation that is NOT a");
  console.log("sendVehicleCommand? (b) what is the schedule's amperage field type?");
  console.log("Those answer whether Phase 2 (nonzero-amp write) is worth running.\n");
}

// ---- Phase 2: nonzero-amperage write (GATED, supervised) -------------------

async function phase2(sess: Sess): Promise<void> {
  const gate = process.env.SPIKE_ALLOW_WRITE;
  if (gate !== "yes-i-am-watching-the-car") {
    console.log("=== PHASE 2 — skipped (write test) ===");
    console.log("Phase 2 writes a real schedule to your car. It is intentionally");
    console.log("gated. Only run it while physically watching the vehicle:");
    console.log("  SPIKE_ALLOW_WRITE=yes-i-am-watching-the-car RIVIAN_OTP=... node \\");
    console.log("    --env-file=.env.local --import tsx scripts/rivian-schedule-spike.ts");
    console.log("\nBEFORE running Phase 2, confirm from Phase 1 that the schedule");
    console.log("mutation exists and note its exact input shape. The write payload");
    console.log("and the read-back verification loop still need to be filled in");
    console.log("against the introspected schema (deliberately left as the last");
    console.log("manual step so a nonzero-amp schedule is never written blind).");
    console.log("\nSafety contract for whoever wires it:");
    console.log("  • write ONE schedule with a nonzero amperage (start ~12 A)");
    console.log("  • read the vehicle charge state back on a 30–60s loop (5 min)");
    console.log("  • log whether ev power dropped to ~12 A * voltage or stayed at 48 A");
    console.log("  • ALWAYS clear the schedule again in a finally{} — do not leave a");
    console.log("    permitted-charge window armed (that was the 4/30 trap).");
    return;
  }
  console.log("=== PHASE 2 — WRITE TEST (you asserted you are watching the car) ===");
  console.log("Not yet wired. Fill the payload from the Phase 1 introspection first —");
  console.log("this guard exists so a nonzero-amperage schedule is never written to");
  console.log("the live car from an unverified schema. See the safety contract above.");
}

// ---- main ------------------------------------------------------------------

async function main(): Promise<void> {
  const sess = await authenticate();
  console.log("Authenticated. Running spike against the Rivian gateway.");
  await phase1(sess);
  await phase2(sess);
}

main().catch((err) => {
  console.error("\nSpike failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
