// Get the RAW Tesla response from setBackupReserve. The wrapper in
// client.ts collapses anything that isn't code 200/201 to ok:false,
// hiding the actual error message. We need the full body to diagnose.
//
//   node --env-file=.env.local --import tsx scripts/audit-actuator-raw.ts

import { getToken } from "../src/lib/db";
import { TESLA_API_BASE, refreshAccessToken, tokenResponseToRecord } from "../src/lib/tesla/auth";
import { saveToken } from "../src/lib/db";

void (async () => {
  let tok = await getToken("tesla");
  if (!tok?.system_id) {
    console.error("no tesla token / system_id");
    process.exit(1);
  }

  // Force-refresh to make sure the scope is fresh, in case the access
  // token has drifted since the last successful write.
  if (process.env.TESLA_CLIENT_ID && tok.refresh_token) {
    console.log("Refreshing access token to ensure scope freshness…");
    const fresh = await refreshAccessToken({
      clientId: process.env.TESLA_CLIENT_ID,
      refreshToken: tok.refresh_token,
    });
    const next = tokenResponseToRecord(fresh, tok.system_id);
    await saveToken(next);
    tok = next;
    console.log(`new token scope claim: ${(fresh as { scope?: string }).scope ?? "(empty)"}`);
  }

  const url = `${TESLA_API_BASE}/api/1/energy_sites/${tok.system_id}/backup`;
  const body = JSON.stringify({ backup_reserve_percent: 20 });

  console.log(`\nPOST ${url}`);
  console.log(`body: ${body}`);
  console.log(`auth: Bearer …${tok.access_token.slice(-8)}\n`);

  const r = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tok.access_token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body,
  });

  console.log(`HTTP ${r.status} ${r.statusText}`);
  console.log(`headers:`);
  r.headers.forEach((v, k) => console.log(`  ${k}: ${v}`));
  const text = await r.text();
  console.log(`\nbody:`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
})();
