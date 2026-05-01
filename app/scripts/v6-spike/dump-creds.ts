// One-shot: dump the Rivian phone-key credentials we already enrolled
// last night into a local JSON file the Python BLE spike script can
// read. Avoids putting the keypair in env vars or copy-pasting it.
//
// Run: cd app && npx tsx --env-file=.env.local scripts/v6-spike/dump-creds.ts
//
// Output: scripts/v6-spike/creds.json (gitignored — DO NOT commit).

import fs from "node:fs";
import path from "node:path";
import { getToken } from "@/lib/db";
import {
  RIVIAN_CLIENT_NAME,
  RIVIAN_GATEWAY_URL,
  RIVIAN_USER_AGENT,
} from "@/lib/rivian";

// We need vasVehicleId from getUserInfo (we never persisted it; only
// stored the vehicle public key). One quick GraphQL call.
const QUERY = `query getUserInfo {
  currentUser {
    __typename id
    vehicles { id vas { __typename vasVehicleId vehiclePublicKey } }
  }
}`;

async function fetchVasVehicleId(vehicleId: string): Promise<string> {
  const tok = await getToken("rivian");
  if (!tok) throw new Error("no rivian token");
  const meta = (tok.meta as { csrf_token?: string; a_sess?: string }) ?? {};
  const res = await fetch(RIVIAN_GATEWAY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "apollographql-client-name": RIVIAN_CLIENT_NAME,
      "user-agent": RIVIAN_USER_AGENT,
      "u-sess": tok.access_token,
      "a-sess": meta.a_sess ?? "",
      "csrf-token": meta.csrf_token ?? "",
    },
    body: JSON.stringify({
      operationName: "getUserInfo",
      query: QUERY,
      variables: {},
    }),
  });
  if (!res.ok) throw new Error(`getUserInfo HTTP ${res.status}`);
  type Vehicle = { id: string; vas?: { vasVehicleId?: string; vehiclePublicKey?: string } };
  const j = (await res.json()) as { data?: { currentUser?: { vehicles?: Vehicle[] } } };
  const vehicles = j.data?.currentUser?.vehicles ?? [];
  const v = vehicles.find((x) => x.id === vehicleId);
  const id = v?.vas?.vasVehicleId;
  if (!id) throw new Error("vasVehicleId not found in getUserInfo response");
  return id;
}

async function main() {
  const tok = await getToken("rivian");
  if (!tok) throw new Error("no rivian token in DB — connect Rivian first");
  const meta = tok.meta as Record<string, string> | null;
  if (
    !meta?.command_private_key ||
    !meta?.command_vehicle_public_key ||
    !meta?.command_vas_phone_id
  ) {
    throw new Error(
      "rivian token meta missing command_* fields — phone-key not enrolled yet",
    );
  }

  const vehicleId = tok.system_id;
  if (!vehicleId) throw new Error("no system_id (vehicle UUID) on rivian token");

  console.log("Fetching vasVehicleId for vehicle", vehicleId, "...");
  const vasVehicleId = await fetchVasVehicleId(vehicleId);

  // Bretterer's lib expects the private key as base64-encoded PEM.
  // Helios stored it as raw PEM. Convert.
  const privateKeyB64 = Buffer.from(meta.command_private_key, "utf-8").toString("base64");

  const out = {
    // For the cloud handshake validation:
    vehicle_id: vehicleId,
    vas_vehicle_id: vasVehicleId,
    vas_phone_id: meta.command_vas_phone_id,
    identity_id: meta.command_identity_id,
    // For the BLE pair_phone() call:
    vehicle_public_key: meta.command_vehicle_public_key, // hex
    private_key_b64: privateKeyB64, // base64-encoded PEM
  };

  const outPath = path.join(__dirname, "creds.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log("Wrote", outPath);
  console.log("---");
  console.log("vasPhoneId:    ", out.vas_phone_id);
  console.log("vasVehicleId:  ", out.vas_vehicle_id);
  console.log("identityId:    ", out.identity_id);
  console.log("vehiclePubKey: ", out.vehicle_public_key.slice(0, 16) + "..." + out.vehicle_public_key.slice(-8));
  console.log("privateKey:    ", "[" + (privateKeyB64.length) + " chars base64-PEM]");
  console.log("---");
  console.log("Next: cd scripts/v6-spike && python3 spike.py");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
