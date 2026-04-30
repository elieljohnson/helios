// One-shot discovery probe: hit Smartcar V3's bulk-signals endpoint and
// dump every signal the connected vehicle exposes, with status + value.
// Read-only, M2M token, no state change. Used once to harvest the exact
// signal codes Helios's V3 client should request.
//
// Run: cd app && npx tsx scripts/discover-smartcar-signals.ts

import fs from "node:fs";

function loadEnv() {
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(".env.local", "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

async function main() {
  const env = loadEnv();
  const tokRes = await fetch("https://iam.smartcar.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.SMARTCAR_CLIENT_ID,
      client_secret: env.SMARTCAR_CLIENT_SECRET,
    }).toString(),
  });
  if (!tokRes.ok) throw new Error("M2M token: " + tokRes.status + " " + await tokRes.text());
  const tok = (await tokRes.json() as { access_token: string }).access_token;

  const userId = "1fa375e5-0e19-4ff9-ab4f-d9b2cbfe91d8";
  const vid = "9c0d7a1d-d63b-47b8-bdbf-eea34cd7f969";

  const r = await fetch(`https://vehicle.api.smartcar.com/v3/vehicles/${vid}/signals`, {
    headers: {
      Authorization: `Bearer ${tok}`,
      "sc-user-id": userId,
      Accept: "application/json",
    },
  });
  console.log("HTTP", r.status);
  const j = await r.json() as { data?: Array<{
    id: string;
    attributes: {
      code: string;
      name: string;
      group: string;
      status: { value: string };
      body?: unknown;
    };
  }>; errors?: unknown };

  if (!Array.isArray(j.data)) {
    console.log(JSON.stringify(j, null, 2).substring(0, 2000));
    return;
  }

  console.log("Total signals:", j.data.length);
  console.log("---ALL SIGNAL CODES + STATUS---");
  for (const s of j.data) {
    const a = s.attributes;
    const valLine = a.body ? JSON.stringify(a.body) : "";
    console.log(`${a.code}  [${a.group}/${a.name}]  status=${a.status?.value ?? "?"}  body=${valLine}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
