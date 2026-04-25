// Inject the simulator's tokens directly into oauth_tokens to prove
// the V2 vehicle client works end-to-end. After running, hit
// /api/integrations — should see SoC + charging from the sim vehicle.
//
//   node --env-file=.env.local --import tsx scripts/inject-sim-tokens.ts

import { saveTokens, pinVehicleId } from "../src/lib/smartcar";

const SIM = {
  accessToken: "2ee72d71-7278-4fab-9d68-ced542dc4bdb",
  refreshToken: "54a6f554-3814-41a4-b462-bce5757c9234",
  vehicleId: "7bae7cb9-9824-48ad-a567-62508d9a4a1f",
  // Simulator tokens are documented as long-lived; treat as ~24h.
  expiresInSec: 24 * 60 * 60,
};

async function main(): Promise<void> {
  await saveTokens({
    accessToken: SIM.accessToken,
    refreshToken: SIM.refreshToken,
    expiresInSec: SIM.expiresInSec,
    vehicleId: SIM.vehicleId,
  });
  await pinVehicleId(SIM.vehicleId);
  console.log("Injected simulator tokens. Hit /api/integrations to verify.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
