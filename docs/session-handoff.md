# Session handoff — 2026-04-29 → 2026-04-30

Long continuous session covering: data-source plumbing, two real-money incidents, three postmortems, and a tariff-economics fix that may be the highest dollar-impact-per-line-of-code change in the project so far.

This file is for the next agent. Pick up where this one left off.

## Headline state

- **Production is healthy.** Self-sufficiency 100% today, $0 cost, sources all live, conservation reconciles, automation on (user re-enabled manually this morning).
- **Helios still has zero working stop authority over the Rivian.** `stopCharging` is a no-op patch (commit `12a2d27`). Manual stop = unplug or lower charge limit at-or-below current SoC.
- **The peak-hour grid trap is closed.** NEM 2.0 reserve-raise removed (commit `7003612`). Today's morning bridge fired correctly: reserve dropped 20% → 10% at 09:50, recovered to 20% by 10:20.
- **Open P0**: wire one-shot `CHARGE_STOP` via Rivian's vehicle-command API. Replaces the no-op. Estimated 2–4h of focused work.

## What this session shipped (newest first)

| Commit | Summary | What it actually does |
|---|---|---|
| `f52b85b` | HeroCard imbalance warning | Inline note when `\|supply − demand\| ≥ 0.5 kW`. Honors existing comment that promised to "surface it visually rather than silently miscount." |
| `b70ad02` | Postmortem update — charge-limit auto-revert | Documents Rivian's third autonomous behavior pattern (profile-level reset overnight). |
| `7003612` | **Remove NEM-2.0 peak guards** | `decide.ts` no longer raises reserve during peak/mid-peak. Tests + AGENTS.md rule + postmortem updated. ~$900/year recovered. |
| `c5e1d73` | Postmortem update — phase-2 autonomous resume | Manual Stop press at 19:30 didn't durably halt the car; ~$1.30 of additional peak imports before re-detection. |
| `02624e0` | Postmortem 2026-04-30 v1 | Rivian schedule-trap incident. Initial timeline + factors. |
| `027e0a8` | Wrap `getConfig()` in cron route | Neon cold-start hiccup pauses the tick cleanly instead of 500ing. |
| `12a2d27` | **No-op `stopCharging`** | Rivian schedule mutations are not stop commands. Patch caps Helios damage. |
| `2f63c20` | Data-health badge in dashboard header | Renders only when sources are `unavailable` or assembly errored. Plus inline notice in LiveDecisionCard when stale. |
| `877154b` | **Typed `ProviderStatus` per domain** | `StatusResponse.sources` carries `{ provider, status: "live" \| "unavailable" \| "mock" }`. Engine gate flipped from `=== "mock"` to `!== "live"`. |

## The Rivian story (this is the next agent's main thread)

### Three distinct autonomous behaviors observed

1. **Schedule mutations rendered as permitted-charge windows.** Rivian's `setChargingSchedules` mutation is the API surface for the user-facing **"Charge off-peak and save"** feature. An active schedule (`enabled: true`) means *charge during this window*, regardless of `amperage` value. `amperage: 0` is treated as "no specified limit," so the car defers to the wall connector's offered current (48A on a Tesla TUWC).
2. **Default-charge-to-limit when no active schedule.** With the cable connected, no active schedule, and SoC below charge limit, Rivian autonomously charges to limit at full rate. Pressing Stop in the Rivian app is a *soft pause* that auto-resumes within minutes.
3. **Profile-level charge-limit auto-revert.** User-set "session-level" charge limits (e.g., lowered to 73% to force at-target stop) revert to the "profile-level" default (80%) after vehicle wake/sync events. The session manual STOP at the contactor level held; the limit reset fired independently.

### `stopCharging` implementation history

| Version | Approach | Outcome |
|---|---|---|
| v1 | Empty schedules array | Rivian rejected with `BAD_REQUEST_ERROR` |
| v2 | Single `enabled: false` sentinel for Mon at (0,0) | Rivian accepted but car kept charging — geofence wrong + inert schedule = car defaults to charge |
| v3 | Active schedule, geofence at home, `amperage: 0` | The 2026-04-30 incident. Rivian rendered as off-peak charge window; cron stop calls actively *configured* the car to charge at peak hours |
| v4 (current) | No-op, returns `{success: false}` | Caps Helios damage. Cron logs "Stop EV charge (write failed)" honestly. **No stop authority.** |
| v5 (next) | One-shot `CHARGE_STOP` via Rivian's **vehicle-command API** (different surface from `setChargingSchedules`) | TBD |

### What v5 needs

The Rivian unofficial API has two distinct surfaces. We've been using (a); we need (b):

- **(a) `setChargingSchedules`** — recurring/scheduled charging windows. What we've been mis-using.
- **(b) `sendVehicleCommand`** (or similar imperative endpoint) — one-shot commands like `CHARGE_START`, `CHARGE_STOP`, `CABIN_HVAC`, etc. Not yet wired.

Suggested approach for the next session:

1. **Probe the Rivian unofficial API for the command surface.** Reference: [https://rivian-api.kaedenb.org/](https://rivian-api.kaedenb.org/) is the community doc the existing schedule code cites. Look for the `commands` or `actions` section there or in the iOS/Android app traffic.
2. **Add a `sendVehicleCommand` wrapper** in `app/src/lib/rivian/client.ts` mirroring the existing GraphQL operation pattern. New types in `rivian/types.ts`.
3. **Replace `stopCharging` body** with `sendVehicleCommand({ command: "CHARGE_STOP", vehicleId })`. Keep the no-op fallback path if the command surface is unavailable, log the choice.
4. **Belt-and-suspenders**: while in the command API, probe whether `setChargeLimit` (or equivalent) is also available. Each Rivian state level (session, profile) has its own auto-revert; setting the *profile-level* limit ≤ current SoC would close the autonomous-resume window.
5. **Verification loop**: after a stop, on the next cron tick, if `ev_w > 100 W` log a `charge` action with `ok: false` and reason "stop ack'd but car still drawing N kW." This catches future stop-failure modes mechanically, not just this specific one.
6. **Tests**: pure-function paths only — actuator code can't be unit-tested without network mocking. Cover the cron route's verification-loop branch with a synthetic snapshot.

## Hypotheses tried and ruled out (this session)

### Source-of-truth for the 2026-04-29 mock incident

- **"Tesla Fleet API failed transiently."** ✓ Confirmed. The actual root cause was upstream. The bug we owned was the *catch block* that silently kept mock values.
- **"Maybe the engine had a logic bug in pre-departure mode."** ✗ Ruled out. The math reproduced the 7.7 kW logged exactly when given the mock values: `houseW = max(0, 1400-5800) = 0; surplusKw = (7700-0)/1000 = 7.7`. Engine was correct given bad inputs.
- **"The 80 stop commands didn't take effect because of a Tesla API issue."** ✗ Ruled out 24 hours later. It's a Rivian schedule-semantics issue, not Tesla. (See 2026-04-30 postmortem.)

### Source-of-truth for the 2026-04-30 schedule-trap incident

- **"Helios's stop must have been silently failing."** ✗ Ruled out by reading the activity log. All 12 stop calls returned `OK`. Mutation succeeded.
- **"Rivian's `amp=0` schedule doesn't halt in-progress sessions."** ✗ Half-true. The deeper truth: any `enabled: true` schedule is rendered by the Rivian app as a **charge-during-this-window** entry. The car was honoring the schedule, not ignoring it.
- **"Maybe we need a higher amperage threshold."** ✗ Wrong direction. Lower amperage doesn't force stop; the wrong API surface is being called.
- **"Manual STOP from the Rivian app should be durable."** ✗ Empirically false (phase 2 of the same incident). It's a soft pause.
- **"Lowering the Rivian charge limit below current SoC is a durable workaround."** ✗ Falsified the next morning when the limit auto-reverted to 80%.

### Source-of-truth for the peak-hour PW-not-helping observation

- **"Maybe the engine wasn't firing the peak guard correctly."** ✗ It was firing it correctly — that was the bug. The guard itself was wrong.
- **"Reserve at 60% during peak preserves stored energy."** ✗ Tariff-environment assumption that no longer holds. Rationale was NEM 2.0 export arbitrage; under NEM 3.0 the export rate is flat $0.04/kWh and the cost-rational play is to discharge through peak.

## Open todos (priority ordered)

1. **[P0] Wire proper one-shot Rivian `CHARGE_STOP` via vehicle-command API** — replaces no-op from `12a2d27`. Includes verification loop and `setChargeLimit` probe. **Pick this up first.**
2. **[P1] Cron gate should include `vehicle` source** — phantom EV-state actuation risk for users with Tesla up + no-WC + no-Rivian. Needs a `not_configured` vs `unavailable` distinction so PW-only users don't get over-blocked.
3. **[P1] Split `vehicle` source into charger-side + car-side** — Tesla owns charger fields (`ev_w`, `ev_charging`, `ev_plugged_in`); Rivian/Smartcar own car fields (`ev_soc`, `ev_target`, `ev_range`). Current single tag conflates them.
4. **[P2] `pw_reserve` from Tesla `site_info` has nested try** — site_info-failure leaves `pw_reserve` mock-derived while `sources.powerwall` is `live`. Engine reads it for `should_act`.
5. **[P2] Wrap remaining DB-touching cron calls** (`writeSnapshot`, `secondsSinceLastAction`, stale-gate `appendAction`).
6. **[P2] Move `mockStatus()` out of production bundle** — env-gated import or test-only file.
7. **[P3] Add `morning_bridge_floor_pct` to Settings UI** — currently API-only (~15 min).
8. **[deferred] Pull-to-refresh** — likely unnecessary with persistent cache + visibility refresh + freshness indicator already in place.

## Files most relevant to next session

- `app/src/lib/rivian/client.ts` — where the no-op lives. Lines ~339-367.
- `app/src/lib/rivian/types.ts` — type definitions for the GraphQL surface.
- `app/src/app/api/cron/decide/route.ts` — `fireEvAction()` is the call site for stop commands.
- `app/src/lib/decideEvCharge.ts` — engine that decides when to stop. Don't change this for the actuator fix; it's already correct.
- `docs/postmortems/2026-04-30-rivian-schedule-trap.md` — full incident context including action-item list with the v5 spec.

## Things to NOT do next session

- **Don't try `enabled: false` (v2) or `amperage: 0` (v3) again.** Both proven failure modes; the docstring on `stopCharging` preserves the history so future contributors don't repeat them.
- **Don't enable automation off in test deployments without telling the user first.** "Automation off" is not a safe state — Rivian's defaults take over. (See 2026-04-30 postmortem, lesson #5.)
- **Don't ship a tariff-dependent rule without citing its tariff and arbitrage at the call site.** Rule documented in `app/AGENTS.md` "Tariff-environment assumptions are not invariants."
- **Don't trust API success as physical-state confirmation.** Verification loops on actuators with observable state. (Lesson #3 from 2026-04-30 postmortem.)
- **Don't reorder Bash cwd assumptions.** The session shell resets cwd between calls; always `cd /Users/Eliel/Projects/Helios/app &&` before npm commands.

## Lessons that compounded across this session

1. **Open known-unknowns from prior postmortems are time bombs.** The 4/29 postmortem flagged "Investigate Rivian true-stop" as a follow-up. We worked on data-source plumbing (also valuable) instead. 24 hours later the same class of bug recurred via a different path. **Open postmortem items deserve P0 triage.**
2. **Tariff invariants drift silently.** A rule whose justification depended on NEM 2.0 export prices kept costing money under NEM 3.0 with no test catching it, no comment flagging it, no monitor alerting on it. Now there's an `AGENTS.md` rule requiring tariff citation at the call site.
3. **Verify API hypotheses against the canonical UI before shipping.** The Rivian app's rendering of an `enabled: true, amperage: 0` schedule as "Charge off-peak and save" was a 30-second check that would have prevented v3. Reverse-engineered/undocumented APIs especially.
4. **Mock data calibrated for development optics fails in the most expensive direction.** A "rainy-night-no-power" mock would fail safe. The "sunny-noon" mock failed in the most expensive direction (the 2026-04-29 incident).

## Production state at session end

```
2026-04-30 13:03 PT
TOU: off-peak ($0.36/kWh)
Solar: 11.65 kW   |  Home: 2.02 kW (no EV)
EV: 0 kW, 62% SoC, target 80%, plugged in, not charging
PW: 79% SoC, reserve 20%, charging at 9.5 kW (refilling from solar)
Grid: 0 kW
Self-sufficiency today: 100%
Cost today: $0.00
Sources: all live, no assembly errors
Conservation: supply 11.65 = demand 11.65 ✓
```

The system is doing exactly what it should be doing for a sunny mid-day. Tomorrow's continuation begins with the Rivian command-API work.
