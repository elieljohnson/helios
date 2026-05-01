// Polls /api/status every 3 seconds and prints ev_w + ev_charging.
// Use during the v5 live test to watch the car's response to
// stopCharging() in real time.
//
// Run: cd app && npx tsx scripts/test-rivian-watch.ts
// Stop: Ctrl-C
//
// Defaults to local dev server. Override with HELIOS_BASE env var.

const BASE = process.env.HELIOS_BASE ?? "http://localhost:3000";
const POLL_MS = 3000;

type Snapshot = {
  snapshot: {
    ev_w: number;
    ev_charging: boolean;
    ev_soc: number;
    ev_plugged_in: boolean;
  };
};

async function tick() {
  const t = new Date().toLocaleTimeString("en-US", { hour12: false });
  try {
    const r = await fetch(`${BASE}/api/status`);
    if (!r.ok) {
      console.log(`${t}  HTTP ${r.status}`);
      return;
    }
    const j = (await r.json()) as Snapshot;
    const s = j.snapshot;
    const charging = s.ev_charging ? "CHARGING" : "idle    ";
    const plugged = s.ev_plugged_in ? "plug" : "unplg";
    console.log(
      `${t}  ${charging}  ev_w=${String(s.ev_w).padStart(6)} W  soc=${s.ev_soc}%  ${plugged}`,
    );
  } catch (e) {
    console.log(`${t}  ERROR: ${(e as Error).message}`);
  }
}

console.log(`Watching ${BASE}/api/status every ${POLL_MS}ms. Ctrl-C to stop.`);
console.log("---");
tick();
setInterval(tick, POLL_MS);
