// Local smoke test: call assembleStatus() once and dump the EV-related
// fields. Confirms the Tesla cloud WC overlay populates ev_w and
// ev_charging from live_status before we deploy to prod.
//
//   node --env-file=.env.local --import tsx scripts/smoke-cloud-wc.ts

import { assembleStatus } from "../src/lib/status";

void (async () => {
  const status = await assembleStatus();
  console.log(JSON.stringify({
    ev_w: status.snapshot.ev_w,
    ev_charging: status.snapshot.ev_charging,
    ev_soc: status.snapshot.ev_soc,
    ev_range: status.snapshot.ev_range,
    sources: status.sources,
    ts: status.timestamp,
  }, null, 2));
})();
