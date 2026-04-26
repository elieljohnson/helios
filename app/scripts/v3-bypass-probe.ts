// Verify Path B: M2M token → V3 connections → V3 signal endpoints,
// no per-vehicle access_token (no OAuth code exchange).
//
// If this returns 200 on signals for our connected vehicle(s), then
// the broken /oauth/token endpoint is NOT a blocker for V3 — we just
// need to refactor the callback to capture user_id and skip the code
// exchange.
//
//   node --env-file=.env.local --import tsx scripts/v3-bypass-probe.ts

import { getApplicationToken } from "../src/lib/smartcar/auth";

const VEHICLE_API_BASE = "https://vehicle.api.smartcar.com/v3";

const SIGNALS = [
  "StateOfCharge",
  "Range",
  "IsCharging",
  "IsChargingCableConnected",
];

async function main(): Promise<void> {
  const t = await getApplicationToken();
  console.log(`M2M token: len=${t.length} prefix=${t.slice(0, 20)}…`);

  // 1. List connections
  const cRes = await fetch(`${VEHICLE_API_BASE}/connections`, {
    headers: { Authorization: `Bearer ${t}`, Accept: "application/json" },
  });
  console.log(`\n/v3/connections → ${cRes.status}`);
  const cText = await cRes.text();
  console.log(cText.slice(0, 1500));

  if (cRes.status !== 200) {
    console.log("\n[stop] connections call failed; can't probe signals");
    return;
  }

  const json = JSON.parse(cText) as {
    data: Array<{
      id: string;
      attributes: { vehicle: { make: string; model: string; mode?: string } };
      relationships: {
        vehicle: { data: { id: string } };
        user: { data: { id: string } };
      };
    }>;
  };

  // 2. For each connection, probe signals
  for (const c of json.data) {
    const vId = c.relationships.vehicle.data.id;
    const uId = c.relationships.user.data.id;
    const mode = c.attributes.vehicle.mode ?? "?";
    console.log(
      `\n---- ${c.attributes.vehicle.make} ${c.attributes.vehicle.model} [${mode}] vehicle=${vId} user=${uId} ----`,
    );
    for (const sig of SIGNALS) {
      const r = await fetch(
        `${VEHICLE_API_BASE}/vehicles/${vId}/signals/${sig}`,
        {
          headers: {
            Authorization: `Bearer ${t}`,
            Accept: "application/json",
            "sc-user-id": uId,
          },
        },
      );
      const body = await r.text();
      const tag = r.ok ? "✅" : r.status === 404 ? "❌" : "⚠️ ";
      console.log(`  ${tag} ${r.status}  ${sig.padEnd(28)}  ${body.slice(0, 200)}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
