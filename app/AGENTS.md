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

# Tariff-environment assumptions are not invariants

Helios reasons about cost. Cost is a function of the user's **tariff** (rate plan, export terms, peak hours). When the tariff changes — either because the user switched plans, the utility revised the schedule, or a new regime supersedes the old — *every rule that compares "saving for later" against "spending now" needs to be re-derived from the new economics, not carried forward as-is.*

## Anti-pattern (treat as P1 if found)

A rule whose justification depends on prices/hours that no longer match the user's actual tariff. Especially: rules whose comments cite "to preserve" or "to save for" without naming the specific arbitrage they're capturing and whether that arbitrage still exists.

## Concrete failure mode

Pre-2026-04-30, `decide.ts` raised PW reserve to 60% during peak hours "to preserve stored energy." That rule was rational under **NEM 2.0**, where peak-rate exports paid retail (~$0.58/kWh) and saving PW for peak export was profitable arbitrage.

Under **NEM 3.0** (NBT, the user's current tariff), exports pay a flat ACC rate of ~$0.04/kWh year-round. The peak-export arbitrage is gone. The economically rational play during peak is to discharge PW into home/EV loads, *avoiding* the $0.58/kWh import. Holding reserve at 60% during peak forced grid imports at the most expensive rate of the day — the exact opposite of cost minimization.

Rough cost: ~$6/peak-day, ~$900/peak-season at this house's load profile, every day the rule was active.

Removed in commit `<this commit>`. The `reserve_peak_pct` config knob is preserved on `ConfigResponse` so a user on a tariff where the old behavior pencils (legacy NEM 2.0, hybrid plans, certain commercial schedules) can re-enable from Settings.

## Required pattern

When introducing or modifying any rule whose behavior depends on a price or rate window:

1. **Cite the specific arbitrage by name** in the rule's comment ("export-peak arbitrage under NEM 2.0," "off-peak-import arbitrage under E-TOU-C," etc.).
2. **Name the tariff regime it applies to.** "NEM 2.0," "NEM 3.0/NBT," "E-TOU-C 2025," etc.
3. **State the price-comparison invariant** the rule relies on (e.g. "this rule assumes peak_export_rate > off_peak_import_rate").
4. **If the rule would be wrong under any other live tariff regime**, gate it behind a config flag whose default matches the user's current regime.

## Rule of thumb

Tariff-dependent rules carry their tariff in their comment. A rule that says "save for later" without naming what later is worth costs ~$0.50/hr to be wrong about, and the wrongness is invisible until someone reconstructs the cost math by hand.

## Background

Incident 2026-04-30 phase 2. Manual stop at 19:30 PT did not durably halt the Rivian (autonomous resume after ~20 min); ~25 min of grid charging at peak rate followed. PW was sitting at exactly the engine-set 60% reserve floor and could not assist. Investigation surfaced the peak guard as a NEM 2.0 holdover. See `docs/postmortems/2026-04-30-rivian-schedule-trap.md`.
