<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Production data discipline

When an external provider (Tesla, Rivian, Enphase, Open-Meteo, Postgres, anything) fails or returns unexpected data, **do NOT keep a mock/default/prior value and continue as if it were real.** The failure must propagate to consumers as `null`, `undefined`, or a typed degraded state.

## Anti-pattern (treat as P0 if found in this codebase)

```ts
try { base.value = await fetchReal(); }
catch (err) { console.error("...failed, keeping mock:", err); }
```

This silently masquerades placeholder data as real. Downstream consumers (engine, UI, rollups) cannot distinguish stale-fake from fresh-real, and act on phantom values.

## Required pattern

- Mark the source as `"stale"` / `"unavailable"` in a sources map
- Engine and UI explicitly handle missing-data cases (engine returns `hold`, UI renders dashes or a degraded indicator, rollups skip the bucket instead of integrating zero or stale)
- Mock data is opt-in for tests + dev only, gated by an env flag, and must NEVER reach the production bundle by default

## Rule of thumb

Fail loudly, never to plausible-looking values.

## Background

Incident 2026-04-29. Tesla Fleet API failed at ~02:10 PT. `assembleStatus`'s `try/catch` kept `mockStatus()` values calibrated for sunny-noon dev iteration (`solar_w=7700`, `pw_soc=78`). Engine evaluated pre-departure mode against the phantom snapshot, pushed a 32A overnight charge schedule. ~$6.73 in unintended grid imports + Powerwall drained to floor before manual intervention.

Tactical fix in `244df30`. Structural fix (`Partial<EnergySnapshot>` with explicit provider status threaded through every consumer) still pending. See `docs/postmortems/2026-04-29-mock-data-incident.md` for the full timeline and lessons.
