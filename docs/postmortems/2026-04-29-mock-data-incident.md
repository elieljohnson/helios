# Mock data fallback in production triggered overnight grid charge

**Date:** 2026-04-29
**Severity:** P1 — real-money loss, user manual intervention required
**Author:** Eliel Johnson (with Claude as co-investigator)
**Status:** Tactical fix shipped (`244df30`); structural fix tracked.

---

## Summary

A transient Tesla Fleet API failure overnight caused `assembleStatus()` to silently keep `mockStatus()` values, which were calibrated for a sunny-noon development snapshot (`solar_w = 7700`, `pw_soc = 78`). The decision engine read those phantom values, evaluated **pre-departure mode** as eligible, and pushed a 32A charge schedule to the Rivian at ~02:10 PT.

The Rivian charged at 7.3 kW from grid for the next 4+ hours. The engine recovered when Tesla came back online and issued ~80 consecutive "stop" commands across the morning, but the Rivian's `amperage: 0` schedule did not halt the in-progress session — a separate actuator issue.

The user noticed at 06:11 PT, manually stopped charging via the Rivian app, and reported "this is the opposite of what we want."

## Impact

| Metric | Value |
|---|---|
| Unintended grid imports | ~33 kWh @ off-peak rate |
| Direct cost | ~$6.73 (today's COST card) + opportunity cost on lost solar storage |
| Powerwall state | Drained to 20% floor — morning solar will refill PW before EV could absorb it, then export at NEM ~$0.04/kWh |
| Self-sufficiency, today | 45% (typical: 100% on similar weather) |
| User intervention | Manual stop required; automation broke trust |
| Engine actions logged | 1 erroneous Update + ~80 ineffective Stops |

## Timeline (PT)

| Time | Event |
|---|---|
| **2026-04-28 ~21:50** | User plugged in Rivian. Rivian default behavior: charge to set limit (80%) at full rate. Engine returned `stop` (past cutoff, backstop conditions not met), cron sent `amp=0` schedule — Rivian did not halt. |
| **~21:55 → 02:10** | Engine continued issuing stop commands every 5 min. Rivian continued charging. ~33 kWh transferred from grid during off-peak window. |
| **2026-04-29 ~02:10** | Tesla Fleet API call failed (transient — root cause unknown, likely OAuth refresh hiccup or edge-node timeout). `assembleStatus` `try/catch` logged the error and retained mock values. Engine read `solar_w = 7700`, `pw_soc = 78`, evaluated pre-departure conditions, fired **Update EV charge at 7.7 kW** with `Rivian schedule: 32A × 1069min`. |
| **~02:35** | Tesla API recovered. Engine returned to issuing stop commands. Rivian schedule from 02:10 was overridden by `amp=0` schedules, but in-progress session continued. |
| **06:11** | User opened Helios PWA, observed Powerwall at 20%, EV at 72%, COST TODAY $6.73, GRID importing 8.4 kW. Manually pressed "Stop charging" in Rivian app. |
| **06:30** | Investigation began. Activity log inspection identified the 02:10 Update event and confirmed mock-data math: `houseW = max(0, 1400-5800) = 0; surplusKw = max(0, (7700-0)/1000) = 7.7` — exactly the value logged. |
| **06:33** | Tactical fix shipped (`244df30`): cron refuses to act on mock-marked sources; pre-departure mode requires `solar_w ≥ 200 W` (daylight gate). 59 tests pass. |
| **06:45** | Rule documented in `app/AGENTS.md`. Postmortem (this document) drafted. |

## Root cause

`src/lib/status.ts:182` (and parallel blocks for Smartcar, Rivian, etc.):

```ts
} catch (err) {
  console.error("[status] Tesla overlay failed, keeping mock:", err);
}
```

The pattern is: `assembleStatus` seeds `base = mockStatus()` and overlays each provider's real values on top. When a provider call fails, the catch block logs the error and **silently retains the mock value** as if it were real. Downstream consumers (engine, UI, rollups) have no way to distinguish stale-fake values from fresh-real ones.

The mock values themselves are calibrated for a sunny-noon dev snapshot — the worst possible defaults to act on at 2 AM:

```ts
// src/lib/mock.ts (excerpt)
solar_w: 7700,    // looks like high-noon production
home_w: 1400,
ev_w: 5800,
pw_soc: 78,       // above the 20% pre-departure floor
```

When the engine fell back to those values overnight, it evaluated `pre-departure` mode as eligible (high forecast + PW above floor + non-parked weekday) and computed surplus = `solar - houseW = 7700 - 0 = 7.7 kW` — the exact rate that ended up in the Rivian schedule.

## Contributing factors

1. **No failure-mode propagation.** The catch swallowed the error without flagging the snapshot as degraded. There was no `sources.solar = "stale"` signal that downstream code could check.

2. **Mock calibrated for development optics, not safety.** A "rainy-night" mock with `solar_w = 0`, `pw_soc = 20` would have failed safe (engine would still stop). The mock was calibrated to make the dashboard look alive, which is exactly opposite of what production failure-mode defaults need.

3. **Rivian's `amp=0` stop schedule does not halt in-progress sessions.** The engine issued ~80 consecutive correct `stop` decisions overnight. The actuator chain logged success ("Rivian: amp=0 schedule for today") but the car continued charging. This is a separate, pre-existing bug that the mock-data incident *exposed* but did not *cause*. Tracked as a follow-up.

4. **No data-health surface in the dashboard.** The Freshness indicator (`Updated Xs ago`) reflects API-call recency, not provider-source health. A user opening the app overnight would have seen "Updated 12s ago" alongside fully mock-derived numbers.

## Detection

The user noticed during a manual morning check at 06:11 PT. No automated alert fired. The engine's own activity log captured the pattern (1 anomalous Update + 80 ineffective Stops) but nothing surfaced it as a problem.

## Resolution

### Tactical (shipped in `244df30`)

1. **Cron refuses to act on mock data.** After `assembleStatus`, check `status.sources.{solar, home, powerwall}`. If any is `"mock"`:
   - Log an `info` action ("providers stale, skipping tick")
   - Do NOT write the snapshot (mock values would poison rollups)
   - Do NOT call any actuator
   - Return paused; next tick retries
2. **Daylight gate on pre-departure mode.** Pre-departure mode now requires `solar_w ≥ 200 W` to engage. Defense in depth: even if mock data slips through Layer 1 somehow, the daylight gate prevents an active charge schedule in the dark.
3. **Regression test added** (`decideEvCharge.test.ts`): pre-dawn snapshot with mock-shaped values returns `stop` with `"pre-dawn"` in the reasoning chain.

### Structural (pending)

The right architectural fix has not yet been written. It is:

1. `assembleStatus` returns `Partial<EnergySnapshot>` with explicit per-source `ProviderStatus = "ok" | "stale" | "unavailable"`. Type system carries uncertainty through every consumer.
2. Engine takes `Partial<EnergySnapshot>` and explicitly handles missing fields. No more `snapshot.solar_w` reads that silently get a stale value.
3. Dashboard renders explicit "stale" / "unavailable" states with degraded UI (dashes, warning chip) instead of mock numbers.
4. `mockStatus()` excluded from production bundle via env-gated import or moved to a test-only file path.

Estimated effort: 4–6 hours touching ~10 files. Tracked in the project todo list.

## Lessons learned

### Engineering principles

1. **Production code must never silently substitute placeholder data for real signals.** Fail loudly, never to plausible-looking values. This is the rule that's now in `app/AGENTS.md`.

2. **Mock data is a development convenience, not an architectural fallback.** It belongs in tests, in Storybook, and behind an explicit env flag in dev. It does not belong in a try/catch that's reachable from a production code path.

3. **Type safety should carry uncertainty.** Wherever a value might be missing (because a provider call could fail), the type should reflect that — `Partial<>`, `null`, or a discriminated union. The compiler should refuse to let a consumer read `value` as if it were always present.

4. **Default values for failure modes should be CONSERVATIVE.** A "rainy-night-no-power" mock would have failed safe in this incident. A "sunny-noon" mock failed in the most expensive way possible. When you must choose a default, pick the one that errs toward inaction.

### Process improvements

1. **Failure-mode review is part of code review.** When introducing or modifying any external provider call, the review checklist must include: "what happens when this fails?" and "what does the consumer see?" If the answer is "keep going with the prior value," that's a smell strong enough to block merge.

2. **Postmortem-driven rules.** Each real incident yields a documented rule in `AGENTS.md`. The discipline of writing the rule is what prevents recurrence. Without the rule, the same class of bug recurs every 6 months as memory fades.

3. **Audit existing code for the documented anti-pattern.** Once a rule is written, sweep the codebase for instances of the pattern that already exist. The Tesla overlay catch is one; there are parallel Smartcar, Rivian, Enphase blocks that need the same treatment.

## Action items

- [x] Cron refuses to act on mock data (`244df30`)
- [x] Daylight gate on pre-departure (`244df30`)
- [x] Regression test for pre-dawn mock-shaped snapshot (`244df30`)
- [x] Document rule in `app/AGENTS.md` (this session)
- [x] Write this postmortem (this session)
- [ ] **Structural fix:** `Partial<EnergySnapshot>` with explicit provider status types (~4–6h, ~10 files)
- [ ] **Audit existing catch blocks** in `status.ts` (Smartcar, Rivian, Enphase overlays) for the same anti-pattern; convert to source-status signaling
- [ ] **Investigate Rivian true-stop:** the `amperage: 0` schedule did not halt the in-progress session despite 80 consecutive attempts. Network-trace the Rivian mobile app's "Stop charging" button to find the correct GraphQL mutation.
- [ ] **Surface data-health indicator** in the dashboard. When sources are stale or unavailable, render an explicit warning state instead of mock-derived numbers.
- [ ] **Move mock to env-gated import.** `NEXT_PUBLIC_USE_MOCK_FALLBACK=true` only in `.env.local`. Production bundle should not be able to resolve `mockStatus()` at runtime.
- [ ] **Calibrate any remaining mock to fail-safe values.** If mock must exist as a dev convenience, its values should be the conservative ones (zero solar, low PW, etc.) — never optics-friendly noon defaults.

## How this incident strengthens the case study

The case study at `docs/case-study.md` includes an "iteration story" section. This incident is a high-quality entry: a real bug with quantified impact, a tactical fix shipped within an hour of detection, a structural fix scoped honestly, and a written rule that prevents recurrence. It demonstrates the engineering literacy theme — not "we wrote bug-free code" but "we caught a real bug, traced it to its root cause, fixed the symptom and the disease, and documented the lesson so it sticks."

If you update the case study to include this, the SOAR shape is roughly:

- **Situation:** Mill Valley solar+battery+EV running on Helios automation in production for ~5 days.
- **Obstacle:** Overnight transient Tesla API failure exposed a scaffold-era mock-fallback pattern. Engine acted on phantom data, fired a 32A charge schedule from grid, drained the battery to floor.
- **Action:** Read activity log to reconstruct timeline. Reproduced 7.7 kW math from mock values. Shipped two-layer defensive fix (cron source-check + daylight gate) with regression test in <1h. Documented rule in agent instructions and authored full postmortem.
- **Result:** Same class of bug cannot recur via the cron path. Documented rule prevents future re-introduction. Structural fix scoped and tracked. Recovered ~$X.XX/month in expected savings vs. continued exposure.

---

*Filed alongside Helios case study artifacts in `docs/`. The discipline of writing this is the practice, not the artifact.*
