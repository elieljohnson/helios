// Powerwall actuator audit.
//
// Calls setBackupReserve(siteId, CURRENT_VALUE) — a no-op write that
// changes nothing at the house but exercises the full Tesla Fleet API
// write path: token refresh, scopes, backup endpoint, response parsing.
// If this returns ok=true, the actuator is verified.
//
//   node --env-file=.env.local --import tsx scripts/audit-actuator.ts

import { getLiveStatus, getSiteInfo, setBackupReserve } from "../src/lib/tesla";
import { getToken } from "../src/lib/db";

void (async () => {
  const tok = await getToken("tesla");
  if (!tok?.system_id) {
    console.error("no tesla token / system_id in DB");
    process.exit(1);
  }
  console.log(`site_id: ${tok.system_id}`);
  console.log(`token expires: ${tok.expires_at}`);
  console.log(`token scope (from meta): ${(tok.meta as Record<string, unknown> | null)?.scope ?? "(not stored)"}`);

  // Read current state — both live (volatile) and site_info (the reserve setpoint)
  const live = await getLiveStatus(tok.system_id);
  const info = await getSiteInfo(tok.system_id);
  const liveReserve = live.backup_reserve_percent;
  const infoReserve = info.backup_reserve_percent;
  console.log(`\nCurrent reserve (live_status):  ${liveReserve}%`);
  console.log(`Current reserve (site_info):    ${infoReserve}%`);
  console.log(`Live SoC:                       ${live.percentage_charged.toFixed(1)}%`);

  // Pick the value to write back. Prefer site_info — it's the
  // configured target rather than a momentary report.
  const writeValue = infoReserve ?? liveReserve;
  if (writeValue == null) {
    console.error("could not read current reserve");
    process.exit(1);
  }

  console.log(`\n--- No-op write test ---`);
  console.log(`Calling setBackupReserve(${tok.system_id}, ${writeValue})…`);
  const before = Date.now();
  const ack = await setBackupReserve(tok.system_id, writeValue);
  const ms = Date.now() - before;
  console.log(`Tesla returned: ${JSON.stringify(ack)} in ${ms}ms`);
  console.log(ack.ok ? "✅ ACTUATOR PATH VERIFIED" : "❌ ACTUATOR PATH BROKEN");

  // Re-read to confirm
  await new Promise((r) => setTimeout(r, 1500));
  const liveAfter = await getLiveStatus(tok.system_id);
  console.log(`\nReserve after write: ${liveAfter.backup_reserve_percent}%`);
  console.log(`(Should still be ${writeValue}% — no-op intended.)`);
})();
