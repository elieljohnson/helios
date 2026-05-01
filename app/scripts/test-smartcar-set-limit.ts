// Quick: probe setChargeLimit to see if device-pairing also gates it.
// Same caveat as Rivian's: this mutates the profile-level limit.
//
// Run: cd app && npx tsx --env-file=.env.local scripts/test-smartcar-set-limit.ts

import { setChargeLimit } from "@/lib/smartcar";

async function main() {
  // Read SoC and target a value at-or-below it (75% → 75%, no charge headroom).
  const r = await fetch("http://localhost:3000/api/status");
  const j = await r.json();
  const soc = j.snapshot.ev_soc as number;
  console.log("Current SoC:", soc, "% — calling setChargeLimit(", soc, ")");
  const result = await setChargeLimit(soc);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
