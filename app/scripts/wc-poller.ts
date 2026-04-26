// Wall Connector → Helios poller.
//
// Runs on a home-network box (Mac mini, Pi, laptop, anything that's
// always on). Polls the Tesla Universal Wall Connector's local API
// every POLL_INTERVAL_MS and pushes the payload to Helios's ingest
// endpoint. Zero dependencies beyond what tsx already brings.
//
// Env vars (all required):
//   WC_HOST              — IP or hostname of the Wall Connector
//                          (e.g. "192.168.5.15")
//   HELIOS_URL           — base URL of the Helios deployment
//                          (e.g. "https://helios-eeg1.vercel.app")
//   HELIOS_INGEST_SECRET — the same secret set on the server
//
// Optional:
//   POLL_INTERVAL_MS     — default 10000 (10s)
//
// Run with:
//   node --env-file=.env.poller --import tsx scripts/wc-poller.ts
//
// Failure modes:
//   - WC unreachable          → log, sleep, retry next tick
//   - Helios non-2xx          → log status code, sleep, retry next tick
//   - Helios network error    → log, sleep, retry next tick
//
// Never throws out of the loop. The poller is designed to run for
// months unattended.

const WC_HOST = requireEnv("WC_HOST");
const HELIOS_URL = requireEnv("HELIOS_URL").replace(/\/$/, "");
const HELIOS_INGEST_SECRET = requireEnv("HELIOS_INGEST_SECRET");
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? "10000");

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[wc-poller] ${name} is required. Aborting.`);
    process.exit(1);
  }
  return v;
}

function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

async function fetchJson(url: string, timeoutMs = 5000): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${url} → ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function tick(): Promise<void> {
  // Vitals is the hot path. Lifetime is best-effort so a transient
  // failure on the secondary endpoint doesn't block the primary
  // telemetry from reaching the server.
  let vitals: unknown;
  try {
    vitals = await fetchJson(`http://${WC_HOST}/api/1/vitals`);
  } catch (err) {
    console.error(`[${ts()}] vitals fetch failed:`, (err as Error).message);
    return;
  }

  let lifetime: unknown | undefined;
  try {
    lifetime = await fetchJson(`http://${WC_HOST}/api/1/lifetime`);
  } catch {
    // silent — included payload is optional
  }

  try {
    const r = await fetch(`${HELIOS_URL}/api/ingest/wall-connector`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${HELIOS_INGEST_SECRET}`,
      },
      body: JSON.stringify({ vitals, lifetime }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error(`[${ts()}] ingest ${r.status}: ${text.slice(0, 200)}`);
      return;
    }
    // One-line status — pulls the human-meaningful fields back out for
    // tail-the-log debugging.
    const v = vitals as Record<string, unknown>;
    const current = Number(v.vehicle_current_a ?? 0);
    const volts = Number(v.grid_v ?? 0);
    const kw = ((current * volts) / 1000).toFixed(2);
    const sessionKwh = (Number(v.session_energy_wh ?? 0) / 1000).toFixed(2);
    const charging = v.contactor_closed === true && current > 0.5;
    console.log(
      `[${ts()}] ${charging ? "⚡" : "·"} ${kw} kW · session ${sessionKwh} kWh · evse_state=${v.evse_state} · 204 ok`,
    );
  } catch (err) {
    console.error(`[${ts()}] ingest network error:`, (err as Error).message);
  }
}

console.log(
  `[wc-poller] WC=${WC_HOST} → ${HELIOS_URL} every ${POLL_INTERVAL_MS}ms`,
);

// Fire once immediately so the first row hits the DB without waiting
// the full poll interval.
await tick();
setInterval(tick, POLL_INTERVAL_MS);

// Keep the process alive (setInterval alone doesn't, depending on Node
// version + module mode).
process.stdin.resume();
