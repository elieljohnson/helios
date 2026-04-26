// Final exhaustion probe.
//
// Three things to definitively answer:
//
//   1. Is there a stored Smartcar token in our local DB? If yes, can we
//      use that access_token Bearer against V2 + V3 vehicle data?
//      (This token was minted before the V3 dashboard creds were
//      rotated; it might still work even though we can't mint a new one.)
//
//   2. Does the LIVE Rivian R1S respond to /v3/.../signals/{slug} with
//      a kebab-case slug ("state-of-charge") instead of PascalCase?
//
//   3. Does the V2 endpoint shape (api.smartcar.com/v2.0) accept the
//      M2M token at all? (It shouldn't, per Smartcar's split, but
//      cheap to test.)
//
//   node --env-file=.env.local --import tsx scripts/v3-final-probe.ts

import { getApplicationToken } from "../src/lib/smartcar/auth";
import { getToken } from "../src/lib/db";

const RIVIAN_VEHICLE_ID = "9c0d7a1d-d63b-47b8-bdbf-eea34cd7f969";
const RIVIAN_USER_ID = "1fa375e5-0e19-4ff9-ab4f-d9b2cbfe91d8";

async function probe(label: string, url: string, headers: Record<string, string>): Promise<void> {
  const r = await fetch(url, { headers: { Accept: "application/json", ...headers } });
  const body = (await r.text()).slice(0, 250);
  const tag = r.ok ? "✅" : r.status === 404 ? "❌" : "⚠️ ";
  console.log(`  ${tag} ${r.status}  ${label}`);
  console.log(`         ${body}`);
}

async function main(): Promise<void> {
  // (1) DB token
  const tok = await getToken("smartcar");
  console.log("=== (1) Stored Smartcar token in DB ===");
  if (!tok) {
    console.log("  no token row");
  } else {
    console.log(`  access_token: ${tok.access_token.slice(0, 12)}…${tok.access_token.slice(-4)}`);
    console.log(`  refresh_token: ${tok.refresh_token.slice(0, 12)}…${tok.refresh_token.slice(-4)}`);
    console.log(`  expires_at: ${tok.expires_at}`);
    console.log(`  system_id (vehicle): ${tok.system_id}`);
    console.log(`  meta:`, tok.meta);

    // Try this token against V2 vehicle data (per the prod code path)
    console.log("\n  -- V2 with stored access_token --");
    await probe(
      `V2 GET /v2.0/vehicles/${tok.system_id}/battery`,
      `https://api.smartcar.com/v2.0/vehicles/${tok.system_id}/battery`,
      { Authorization: `Bearer ${tok.access_token}` },
    );
    await probe(
      `V2 GET /v2.0/vehicles/${tok.system_id}`,
      `https://api.smartcar.com/v2.0/vehicles/${tok.system_id}`,
      { Authorization: `Bearer ${tok.access_token}` },
    );
  }

  // (2) Kebab-case + variations against the LIVE Rivian
  console.log("\n=== (2) Signal-slug variants on live Rivian R1S, M2M token ===");
  const m2m = await getApplicationToken();
  const slugs = [
    "state-of-charge",
    "StateOfCharge",
    "Charge.StateOfCharge",
    "TractionBattery.StateOfCharge",
    "battery",
    "charge",
    "is-charging",
    "IsCharging",
  ];
  for (const slug of slugs) {
    await probe(
      `V3 /vehicles/{id}/signals/${slug}`,
      `https://vehicle.api.smartcar.com/v3/vehicles/${RIVIAN_VEHICLE_ID}/signals/${slug}`,
      { Authorization: `Bearer ${m2m}`, "sc-user-id": RIVIAN_USER_ID },
    );
  }

  // (3) V2 endpoints with M2M token (should fail, but want to see the error code)
  console.log("\n=== (3) V2 vehicle data with M2M token (control test) ===");
  await probe(
    "V2 GET /v2.0/vehicles (M2M Bearer)",
    "https://api.smartcar.com/v2.0/vehicles",
    { Authorization: `Bearer ${m2m}` },
  );
  await probe(
    `V2 GET /v2.0/vehicles/${RIVIAN_VEHICLE_ID}/battery (M2M Bearer)`,
    `https://api.smartcar.com/v2.0/vehicles/${RIVIAN_VEHICLE_ID}/battery`,
    { Authorization: `Bearer ${m2m}` },
  );

  // (4) V3 vehicle root and connection-scoped paths
  console.log("\n=== (4) V3 alternate paths (connection-scoped, vehicle root) ===");
  const RIVIAN_CONN = "bb650530-80c7-48e0-822f-1cd4e86e7abd";
  await probe(
    `V3 /vehicles/${RIVIAN_VEHICLE_ID}`,
    `https://vehicle.api.smartcar.com/v3/vehicles/${RIVIAN_VEHICLE_ID}`,
    { Authorization: `Bearer ${m2m}`, "sc-user-id": RIVIAN_USER_ID },
  );
  await probe(
    `V3 /connections/${RIVIAN_CONN}`,
    `https://vehicle.api.smartcar.com/v3/connections/${RIVIAN_CONN}`,
    { Authorization: `Bearer ${m2m}` },
  );
  await probe(
    `V3 /connections/${RIVIAN_CONN}/vehicle`,
    `https://vehicle.api.smartcar.com/v3/connections/${RIVIAN_CONN}/vehicle`,
    { Authorization: `Bearer ${m2m}` },
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
