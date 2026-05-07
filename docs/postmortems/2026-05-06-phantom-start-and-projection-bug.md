# Phantom-Start pushes and the projection-formula bug

**Dates:** 2026-05-06 / 2026-05-07
**Severity:** P1 — false push pings (no monetary loss, but eroded trust); PW-healthy refusals leaving EV undercharged on otherwise good days
**Author:** Eliel Johnson (with Claude as co-builder)
**Status:** Shipped — three tactical fixes (Layer 1 plug-state guard, Layer 3 home geofence, natural-limit reframe), one math correction (signed PW-delta in the projection), one data-capture migration for a future learned-target feature.

---

## Summary

Two distinct user-visible failures surfaced over the morning and evening of 2026-05-06, on the heels of an unusual day (wife left late, car physically away from home for several hours mid-day).

The morning failure was a **false-positive Start push** that fired while the car was away from the property. Root cause: the snapshot's `ev_plugged_in` field flapped `true → false → true` on different ticks as the Rivian and Wall Connector overlays disagreed about plug state, with no provider-freshness signal threaded through to the engine. The second-by-second AGENTS.md "production data discipline" anti-pattern, exactly.

The evening failure was a **misframed Stop push** with the Powerwall at 100% (well above the 80% sunset target). The engine's reasoning was alarm-toned ("Forecast too weak — protect Powerwall sunset target") for what was actually just "you've reached today's natural budget." Investigating the user's reaction — *"this feels like math the app should be able to calculate"* — surfaced an underlying math bug: the projection formula only ever **subtracted** PW catch-up needed (when below target) and never **added** PW headroom (when above target). On the screenshot day, 8.1 kWh of PW headroom was sitting invisible to the math.

Both classes of failure were addressed in five tactical commits, plus a sixth that captures the data we'd need to revisit the static `pw_sunset_target_pct` as a learned daily quantity.

## Timeline (PT)

**Tuesday 2026-05-06**

- **06:45–08:25** — Engine fired six Start pushes ("Charge to ~75–77%") on what should have been a non-parked driving day. Cause: `parked_schedule[Wed]` was reading `true` until ~09:00; either user-edited mid-session or a config-cache effect. The morning starts were "correct" given the engine's view of the day.
- **09:00** — Gate 2 hard-stopped the car: *"Today is not a parked day. Car drawing 11.3 kW."* Pre-departure relaxation refused. Snapshot showed `ev_plugged_in: true`, `ev_charging: true`.
- **09:10** — User unplugged. Snapshot reflected `ev_plugged_in: false`.
- **09:45** — **Phantom Start #1.** Snapshot transiently flipped to `ev_plugged_in: true`. Engine fired *"Charge to ~77%"* push. Car was unplugged.
- **09:50** — Back to `ev_plugged_in: false`. Engine returned `noop`.
- **11:50** — **Phantom Start #2.** Same flap, hours later, with the car physically off the property. Engine fired *"Charge to 80%"* push.
- **11:55** — Back to `ev_plugged_in: false`.
- **18:57** — **Premature Stop push** with PW at 100%, EV at 63% drawing 11.4 kW. Reason: *"Forecast too weak — protect Powerwall sunset target."* User's reaction: this is wrong, PW is healthy, engine should be smarter.

**Wednesday 2026-05-07**

- All five fixes shipped (six commits). Six-day data analysis surfaced the static-target question. Migration 0018 added overnight-endpoint capture for the future learned-target feature.

## What we shipped

Listed in commit order, paired against the failure each addressed.

| Commit | Type | What it does |
|---|---|---|
| `764b01e` | fix(engine) | **Layer 1 plug-state flap guard.** When the previous tick's snapshot read `ev_plugged_in: false` and the current tick reads `true`, return `hold` for one tick to confirm before authorizing. Single-tick flaps (the 09:45 and 11:50 phantoms) get swallowed. The cron re-fires every 5 min, so a real plug-in costs at most one tick of latency before recommendations resume. |
| `6840778` | feat(geofence) | **Layer 3a/b — Rivian GPS plumbing.** Added `gnssLocation` to the existing GraphQL query. `RivianEvSnapshot` and `EnergySnapshot` gain optional `lat`, `lng`, `locationAt` fields. New `geofence.ts` module with Haversine distance and a `classifyGeofence()` verdict that honors a 10-min freshness window (sleeping vehicles can return stale GPS). 12 unit tests covering identity, scale, symmetry, freshness, and the at_home / away / unknown branches. |
| `0d40513` | feat(engine) | **Layer 3c — home-geofence guard.** New Gate 1c in `decideEvCharge`: when the car's GPS reports it's farther than `home_geofence_radius_m` from `system.coords`, return `hold` regardless of plug state. Falls back gracefully when GPS is unavailable, stale, or the radius is set to 0. Default 200 m covers a typical residential lot + driveway with margin against ~50 m GPS jitter. The 11:50 phantom would have been caught here even if Layer 1 missed it (it didn't, but defense in depth). |
| `0cb41e0` | fix(push) | **Reframe stop-while-PW-healthy as "set the limit."** Disambiguates two structurally different stop cases in `recommendEvAction`. PW above sunset target + projection refused = natural-limit stop, framed as informational guidance: *"Set Rivian charge limit to 63%. Powerwall projected at 80% by sunset. Car is drawing 11.4 kW."* PW below target + projection refused = real alarm, existing language preserved. Same priority on both (user still acts), distinct signature so they re-fire independently when the classification flips. |
| `b99dd70` | fix(projection) | **Include PW headroom above target as positive EV budget.** The math correction. Old formula: `available_for_ev = solar − house − max(0, target − pw_now)` — only subtracted catch-up; the `max(0, …)` made headroom invisible. New formula: `available_for_ev = solar − house + (pw_now − target)` — signed delta. One sign change, equivalent below target, correctly captures headroom above. The 18:57 case becomes *available = 0.5 − 2.3 + 6.1 = +4.3 kWh → authorize, limit ~67%* instead of refusing. |
| `4513fd7` | feat(db) | **Migration 0018 — overnight PW endpoints in `daily_summaries`.** Four nullable columns: `morning_low_pw_pct`, `morning_low_at_hour_pt`, `evening_high_pw_pct`, `evening_high_at_hour_pt`. `rollupYesterday()` extended to compute them from each day's snapshots. Engine behavior unchanged; static `pw_sunset_target_pct` continues to drive decisions. Captures the data a future learned-overnight-target feature would need without committing to that feature yet. |

Two atomic commits earlier in the same session shipped the **trend-analysis data-capture infrastructure** (migrations 0014–0017, source-attribution helpers, three writer functions wired into the cron) that made migration 0018 cheap to add. Those were really part of yesterday's work but landed in this session's first three commits.

## Why the bugs were dormant until now

**The plug-state flap.** Yesterday's session shipped Layer 1 (Gate 1b) before the 11:50 phantom fired, but the unusual circumstances — wife left late, car spent hours away from home with intermittent vendor reachability — were the exact pathological case for the old "single tick of `true` is enough" gate. We hadn't seen it before because the vendor flapping had only ever happened over short windows where the engine was already in `noop`-noise territory.

**The projection-formula bug.** Almost nobody hits this in normal operation. The math is wrong only when:
1. PW is above sunset target (so headroom should count), AND
2. `solar − house` for the rest of the day is negative or zero (evening, dusk, weak forecast)

In the morning and most of the afternoon, `solar − house` is comfortably positive, so even with the wrong formula, the engine authorizes. The bug only fires in the late-afternoon-into-dusk window with high PW. The 18:57 screenshot was the first time the user noticed because it happened on a day where PW had been deliberately charged up by the user manually, putting the system into the rare state where the bug was visible.

**Lesson.** Math errors that only fire under narrow conditions can hide for weeks. The projection has been in production since 2026-05-04 and presumably misbehaved on prior evenings — but those evenings either had the user not paying attention to mid-day pushes, or PW already low enough that the bug went the other way (refused for a reason that *was* alarming). The user's intuition — *"this is math the app should be able to calculate"* — was the diagnostic that exposed it.

## What we did right

- **Treating Issue 1 (plug-state flap) and Issue 2 (premature stop) as distinct problems.** They surfaced in the same session but had different root causes. Conflating them would have produced a fuzzier fix.
- **Three overlapping defenses for the plug-state flap** rather than one. Gate 1 (current state), Gate 1b (consecutive ticks), Gate 1c (physical reality via GPS). Each catches the others' edge cases. AGENTS.md "Layer 4" structural fix is still the right long-term answer, but tactical defenses reduce the urgency.
- **Adopting the user's framing of the projection bug.** The user said "this feels like math the app should be able to calculate" — which was both correct (the math is straightforward) and diagnostic (the engine wasn't showing the right framing). We followed that intuition all the way to the formula, didn't dismiss it as "the engine is being conservative for a reason."
- **Capturing data before deciding on the learned-target feature.** Migration 0018 lands the data without committing to the feature. Two-to-four weeks of capture lets us validate whether overnight drain has a clear day-of-week pattern before investing in the engine work.

## What we got slightly wrong

- **The integration window in the projection still treats EV draw as continuing all the way to sunset** when it actually stops at cutoff (sunset − 1h). After the formula fix, this matters less — the headroom term swamps the bias — but it's still a small over-pessimism on evenings where the cutoff fires before the integral expires. Worth fixing as a small follow-up.
- **The hardcoded `80` in `recommendEvAction`** for the natural-limit/alarm threshold should be the user's actual `pw_sunset_target_pct`. We hardcoded for ship-velocity. Trivial follow-up to plumb the config through.
- **No test for the integration-window bug** itself. The regression test for the screenshot scenario covers the headroom term, but a separate test that pins "EV draw integrates to cutoff, solar/house to sunset" would catch any future regression on that axis.

## Follow-ups

In rough priority order:

1. **Plumb `pw_sunset_target_pct` through to `recommendEvAction`** — replace the hardcoded `SUNSET_TARGET_DEFAULT = 80`. Trivial.
2. **Fix EV-draw integration window** in the projection (cutoff, not sunset). Small.
3. **DB column + Settings card for `home_geofence_radius_m`** so it's tunable. Small migration plus a Settings card. Probably not urgent until GPS jitter starts marking the car "away" when it's in the driveway.
4. **Layer 4 structural fix per AGENTS.md** — thread `sources.vehicle.status` through to the engine so the engine treats a degraded vendor as untrusted instead of acting on the field. This is the proper long-term answer to the plug-state-flap class of bugs. Larger refactor; the three tactical defenses reduce the urgency.
5. **Learned overnight-target feature** — revisit in 2–4 weeks once `daily_summaries.morning_low_pw_pct` and `evening_high_pw_pct` have meaningful data. If overnight drain shows a clear day-of-week pattern, the engine sets tomorrow's target dynamically. If not, keep the static target.
6. **Issue 2 from the May 6 audit** — the Wednesday `parked_schedule` flip mid-session. Product question (should there be a "today only" override?) more than a bug. No urgency.

## Files changed across this session

11 files, 7 commits, 0 reverts.

```
app/db/migrations/
  0014_control_actions_projection_metadata.sql        (yesterday)
  0015_ev_charge_sessions.sql                          (yesterday)
  0016_forecast_snapshots.sql                          (yesterday)
  0017_daily_summaries_enrichment.sql                  (yesterday)
  0018_daily_summaries_overnight_pw.sql                (today)

app/src/db/schema.ts                                   (yesterday + today)
app/src/lib/db.ts                                     (yesterday + today)
app/src/lib/decideEvCharge.ts                         (today — Layers 1 + 3c)
app/src/lib/decideEvCharge.test.ts                    (today)
app/src/lib/projectPwTrajectory.ts                    (today — formula fix)
app/src/lib/projectPwTrajectory.test.ts               (today)
app/src/lib/recommendEvAction.ts                      (today — natural-limit reframe)
app/src/lib/recommendEvAction.test.ts                 (today)
app/src/lib/rivian/types.ts                           (today)
app/src/lib/rivian/client.ts                          (today)
app/src/lib/status.ts                                 (today)
app/src/lib/geofence.ts                               (today — new)
app/src/lib/geofence.test.ts                          (today — new)
app/src/lib/sourceAttribution.ts                      (yesterday — new)
app/src/lib/sourceAttribution.test.ts                 (yesterday — new)
app/src/app/api/cron/decide/route.ts                  (yesterday)
app/src/app/api/history/morning-pw-lows/route.ts      (today — new, analysis-only)
```

Test count moved from 99 → 136 across the two days (+37). Build green throughout.

## Cross-references

- `AGENTS.md` — Production data discipline + tariff-environment assumptions (the framing both bugs trace back to)
- `docs/postmortems/2026-04-29-mock-data-incident.md` — original instance of the "stale-fake masquerading as real" failure mode
- `docs/postmortems/2026-04-30-rivian-schedule-trap.md` — autonomous-resume incident that motivated the projection's existence
- `docs/postmortems/2026-05-01-option-b-implementation.md` — the Option B decision that made plug-state freshness a hard dependency rather than a nice-to-have
- `docs/project-messaging.md` — title and framing for "Three closed paths and a pivot" (still current)
- `memory/feedback_external_api_quotas.md`, `memory/feedback_query_command_state.md` — the broader pattern of "vendor data hygiene matters more than vendor data pleasantness"
