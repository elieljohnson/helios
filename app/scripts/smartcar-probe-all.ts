// Probe Smartcar V3 signal endpoints against EVERY connection on the
// account (real R1S + simulator side-by-side).
//
// Why: we want a definitive read on whether VEHICLE_NOT_FOUND on the
// real R1S is vehicle-specific (Rivian/Smartcar data layer issue) or
// our code is wrong. If the simulator returns 200 and the R1S 404s on
// the same code path, that's the smoking gun.
//
// Run with:
//   node --env-file=.env.local --import tsx scripts/smartcar-probe-all.ts

import { getApplicationToken } from "../src/lib/smartcar/auth";

const VEHICLE_API_BASE = "https://vehicle.api.smartcar.com/v3";

const SIGNALS = [
  "StateOfCharge",
  "Range",
  "IsCharging",
  "IsChargingCableConnected",
];

type Connection = {
  connectionId: string;
  vehicleId: string;
  userId: string;
  make: string;
  model: string;
  mode: string;
};

async function fetchAllConnections(appToken: string): Promise<Connection[]> {
  const res = await fetch(`${VEHICLE_API_BASE}/connections`, {
    headers: { Authorization: `Bearer ${appToken}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`/connections ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    data: Array<{
      id: string;
      attributes: {
        vehicle: { make: string; model: string; mode?: string };
      };
      relationships: {
        vehicle: { data: { id: string } };
        user: { data: { id: string } };
      };
    }>;
  };
  return json.data.map((d) => ({
    connectionId: d.id,
    vehicleId: d.relationships.vehicle.data.id,
    userId: d.relationships.user.data.id,
    make: d.attributes.vehicle.make,
    model: d.attributes.vehicle.model,
    mode: d.attributes.vehicle.mode ?? "unknown",
  }));
}

async function probeSignal(
  appToken: string,
  vehicleId: string,
  userId: string,
  signal: string,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${VEHICLE_API_BASE}/vehicles/${vehicleId}/signals/${signal}`, {
    headers: {
      Authorization: `Bearer ${appToken}`,
      Accept: "application/json",
      "sc-user-id": userId,
    },
  });
  const body = await res.text();
  return { status: res.status, body: body.slice(0, 250) };
}

async function main(): Promise<void> {
  const appToken = await getApplicationToken();
  const conns = await fetchAllConnections(appToken);
  console.log(`Found ${conns.length} connection(s):`);
  for (const c of conns) {
    console.log(
      `  • ${c.make} ${c.model} (${c.mode}) vehicleId=${c.vehicleId} userId=${c.userId}`,
    );
  }
  console.log();

  for (const c of conns) {
    console.log(`---- ${c.make} ${c.model} [${c.mode}] (${c.vehicleId}) ----`);
    for (const sig of SIGNALS) {
      const { status, body } = await probeSignal(appToken, c.vehicleId, c.userId, sig);
      const tag = status === 200 ? "✅" : status === 404 ? "❌" : "⚠️ ";
      console.log(`  ${tag} ${status}  ${sig.padEnd(28)}  ${body}`);
    }
    console.log();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
