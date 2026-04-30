# Rivian "stop" command was actually configuring charge windows

**Date:** 2026-04-30 (incident peaked 2026-04-29 evening PT)
**Severity:** P1 — real-money loss during peak rate, user manual intervention required
**Author:** Eliel Johnson (with Claude as co-investigator)
**Status:** Tactical fix shipped (`12a2d27`); proper command-API fix tracked.

---

## Summary

Helios's `stopCharging` implementation pushed an "active schedule" (`enabled: true`) with `amperage: 0` to the Rivian via the `setChargingSchedules` GraphQL mutation. The hypothesis was that Rivian would interpret this as "during this window, max charge current = 0 A" — i.e. don't draw.

The hypothesis was wrong. Rivian's schedule system is the user-facing **"Charge off-peak and save"** feature. An active schedule means *charge during this window*. The `amperage: 0` field is treated as "no limit specified," so the car defers to whatever the wall connector offers (48 A on a Tesla TUWC).

Net effect: every cron stop call was *adding/refreshing a permitted charge window* that the car then honored at full rate. Helios was actively configuring the Rivian to charge at peak hours — the exact opposite of the engine's intent.

The user noticed during peak rate at 19:23 PT, observed Powerwall draining at 12.95 kW with the EV pulling 11.3 kW, manually stopped via the Rivian app at 19:30, and disabled automation in Helios.

## Impact

| Metric | Value |
|---|---|
| EV draw during incident window (~50 min, peak rate) | ~9.4 kWh from PW |
| Total EV grid imports today | ~17.3 kWh (39% of 44.4 kWh delivered) |
| Net daily cost at incident time | $6.08 (after NEM credits from 35.7 kWh of solar export) |
| Powerwall trajectory | 80%+ → 72% in ~50 min, on a path to hit reserve floor (60%) within ~22 more min before grid would have taken over at peak |
| User intervention | Manual stop required; same incident class as 4/29 (engine-correct, actuator-broken) |
| Engine actions logged | 12 consecutive "Stop EV charge — OK" between 18:30 and 19:20, all of which were extending the trap rather than halting it |

The *direct* peak-rate import didn't materialize because the user caught it before PW hit reserve. But the EV had already accumulated ~17 kWh of grid imports throughout the day, much of which traced back to phantom charge windows created by Helios's stop commands. A precise "minutes-spent-charging-because-of-Helios-traps" attribution would require replaying the activity log against the snapshot history; rough estimate is on the order of $3–5 of avoidable peak/mid-peak imports.

## Timeline (PT)

| Time | Event |
|---|---|
| **2026-04-29 ~18:30** | TOU transitioned to peak. Engine evaluated `decideEvCharge`, returned `stop` (Wed not parked + past sunset cutoff). Cron called `rivianStopCharging`, which posted a schedule `{startTime: 18:29, duration: 331min, amperage: 0, enabled: true}`. Activity log: "Stop EV charge — OK." |
| **18:30 → 19:20** | Engine fired stop every 5 min. Each call refreshed the schedule with a slightly later startTime. Rivian's app rendered the latest one as "Daily 7:24pm–12am" (a "Charge off-peak and save" entry). The car kept charging at the wall connector's offered amperage. |
| **19:23** | User opened Helios dashboard. Saw PW at 72%, EV at 11.3 kW, PW discharging 12.95 kW, grid 0 W, TOU peak. Reported "powerwall under 80%, car still charging full blast." |
| **19:25** | Investigation began. Pulled `/api/status` and `/api/actions`. Confirmed engine was firing correct stops, but car was still drawing 11.3 kW. |
| **19:26** | User shared Rivian-app screenshot showing the "Daily 7:24pm–12am" entry, toggle on. Smoking gun. |
| **19:27** | Read `src/lib/rivian/client.ts:339`. v3 `stopCharging` was actively pushing `enabled: true` schedules. v3's docstring asserted "amperage: 0 = max-zero amps" but the empirical evidence said otherwise. |
| **19:30** | User pressed Stop in Rivian app and disabled automation in Helios Settings. Bleeding stopped. |
| **19:34** | Tactical fix (`12a2d27`): `stopCharging` is now a no-op. Returns `{success: false}` so cron logs "Stop EV charge (write failed)" honestly. 66 tests pass. |
| **19:35** | Bonus fix (`027e0a8`): wrapped `getConfig()` in cron route — unrelated in-flight work that paused for this incident, shipped together because the tree was already clean. |
| **~19:40** | Postmortem drafted (this document). |

## Root cause

`src/lib/rivian/client.ts:339` (pre-fix):

```ts
const stopSchedule: RivianChargingSchedule = {
  weekDays: [weekDay],
  startTime,                  // ~ now
  duration,                   // ~ 4.5 hours, rest of day
  location: { latitude: opts.coords.lat, longitude: opts.coords.lng },
  amperage: 0,                // assumed "max 0 A"
  enabled: true,              // schedule is active
};
return setChargingSchedule(auth.vehicleId, [stopSchedule]);
```

The hypothesis encoded in v3's docstring: "during this window, max charge current = 0 A — i.e. don't draw."

The empirical reality (from the Rivian app's UI rendering of the same schedule):

> **Schedule** *(toggle on)*
> Daily 7:24pm–12am

That's Rivian's **"Charge off-peak and save"** feature. The schedule defines *when the car is permitted to charge to take advantage of off-peak rates*. `amperage: 0` is either ignored or treated as "no specified limit," falling back to the wall connector's offered current.

So the actual semantics of every cron stop call were:
1. Replace any existing schedules with a single new one
2. New schedule = "permit charging from now until midnight, at default amps, at home"
3. Car interprets: "I'm plugged in, in a permitted window, no constraints — charge."

Each subsequent cron tick (every 5 min) refreshed step 1 with a newer startTime, so the schedule stayed "active" and rolling forward. The activity log's "Stop EV charge — OK" reflected only that the GraphQL mutation succeeded, not that the car had stopped drawing current.

## Contributing factors

1. **Hypothesis was never empirically verified against the live Rivian UI.** v3 was reasoned about from the GraphQL schema (`amperage: number, enabled: boolean`) and from how a generic "schedule with limit" *should* behave. Nobody opened the Rivian app to see how a `{enabled: true, amperage: 0}` payload was actually rendered. The user-facing UI is the canonical interpretation of any consumer API.

2. **The success signal came from the wrong layer.** `setChargingSchedule` returns `{success: true}` when the mutation is accepted, not when the desired physical state is reached. The cron route trusted that signal and logged "Stop EV charge — OK" without confirming that `ev_w` actually dropped on the next tick. A verification loop ("on tick N+1, is `ev_w < 100 W`? if not, the stop didn't work") would have surfaced this within 5 minutes of the first stop, every time it's happened.

3. **Pre-existing unresolved bug from a prior postmortem.** The 2026-04-29 incident explicitly noted: *"the engine issued ~80 consecutive correct `stop` decisions overnight. The actuator chain logged success but the car continued charging. This is a separate, pre-existing bug that the mock-data incident exposed but did not cause."* That note correctly identified the symptom but mis-categorized it as "Rivian's `amp=0` schedule does not halt in-progress sessions" — i.e. as a Rivian-side limitation. The actual mechanism (schedule UI = permitted-to-charge window) was uncovered ~24 hours later by reading the Rivian app's own rendering. **Open known-unknowns from prior postmortems are recurring-incident sources.** The "Investigate Rivian true-stop" todo from 4/29 should have been the next session's first task; instead it sat pending while we worked on data-source plumbing (which was also valuable, but at the cost of letting this trap re-fire in production).

4. **No emergency stop in the activity-feed UI.** Once the user noticed the trap, the only ways to halt it were the Rivian app, the Tesla app, or unplugging. A "STOP CHARGING" button in Helios's own UI — wired to a known-good actuator chain — would have shaved minutes off the response window. Today the Helios UI is read-only for charging actions; that's a deliberate Phase-2 deferral but the floor on response time during an incident is bounded by it.

5. **Schedule mutations were used for a one-shot intent.** Rivian's API has two distinct surfaces: (a) `setChargingSchedules` for recurring/scheduled charging windows (the off-peak feature), and (b) one-shot vehicle commands (`CHARGE_START`, `CHARGE_STOP`, `CABIN_HVAC`, etc.) for imperative actions. Helios was using (a) for an intent that belongs in (b). The two have different semantics, different success criteria, and different blast radii on misuse. Picking the wrong one was the proximate cause; not having a written rule about "schedule mutations are not imperative commands" was a contributing factor.

## Detection

User noticed at 19:23 PT during a routine dashboard check at the start of peak hours, when the COST card and PW SoC indicator were visibly going the wrong direction. No automated alert fired. The 4/29 postmortem already flagged "no data-health surface in the dashboard"; the data-health badge shipped earlier the same day in commits `877154b` + `2f63c20` does not yet cover the actuator-state mismatch class of bug (it tracks source freshness, not "the car ignored our stop command").

## Resolution

### Tactical (shipped in `12a2d27`)

`stopCharging` is now a no-op:

```ts
export async function stopCharging(_opts: {
  coords: { lat: number; lng: number };
  now?: Date;
}): Promise<{ success: boolean }> {
  void _opts;
  return { success: false };
}
```

The cron route already handles `success: false` cleanly — it logs "Stop EV charge (write failed)" with reason "Rivian returned success: false" in the activity feed. The user sees an honest "the engine wanted to stop, the actuator didn't" signal, and the trap can never be re-armed by a cron tick. Manual stop (Rivian app, Tesla app, or unplug) is the user's responsibility in this window.

The full v1→v4 history is preserved in the docstring as a record of failure modes already eliminated, so a future contributor doesn't try `enabled: false` (v2) or `amperage: 0` (v3) again.

### Adjacent (shipped in `027e0a8`)

Wrapped `getConfig()` in the cron route so a Neon cold-start blip pauses the tick cleanly instead of returning a 500. Unrelated to this incident — it was the in-flight work paused when the user reported the EV draw — but landed together since the tree was already clean.

### Proper fix (pending)

Wire one-shot `CHARGE_STOP` via Rivian's **vehicle-command API**, the imperative-action surface that exists alongside `setChargingSchedules`. Sketch:

1. Add a `sendVehicleCommand` GraphQL operation to `src/lib/rivian/client.ts` mirroring how the schedule mutation is structured today.
2. Replace the `stopCharging` no-op body with a call to `sendVehicleCommand({ command: "CHARGE_STOP", vehicleId })`.
3. Keep the schedule-clearing surface as a separate function (`clearChargingSchedules`) for a different intent — when the user is genuinely setting up off-peak charging.
4. Add a verification loop in the cron route: after a stop command, on the next tick, if `ev_w > 100 W` log a `charge` action with `ok: false` and reason "stop ack'd but car still drawing N kW." This catches *any* future class of stop-failure, not just this specific one.

Estimated effort: 2–4 hours, mostly in client.ts + auth-check plumbing, plus testing against the live Rivian. Tracked as todo #4.

## Lessons learned

### Engineering principles

1. **Verify API hypotheses against the canonical UI before shipping.** The Rivian mobile app's rendering of a schedule is the user-facing definition of what that payload means. If our hypothesis would change how the app renders or behaves, we owe ourselves a 30-second check before deploying. This applies double for undocumented or reverse-engineered APIs.

2. **Schedule mutations are not imperative commands.** Recurring/scheduled-window APIs and one-shot command APIs are different surfaces with different semantics. When the intent is "do X right now," the imperative surface is the correct one. When the intent is "permit X during these windows on these days," the schedule surface is correct. Mixing them invites incidents like this one in both directions.

3. **Trust actuator success only after observable state confirms it.** A successful API response means the request reached the server; it does not mean the physical world responded. For any actuator with observable state (battery SoC, charge current, valve position, motor RPM), the verification loop should read back the state on the next tick and log a discrepancy.

4. **Open known-unknowns from prior postmortems are time bombs.** The 4/29 postmortem's "Investigate Rivian true-stop" todo was 24 hours old and unresolved when this incident fired. Postmortem action items deserve the same triage discipline as bug reports. If they're "P1 because they enable real-money loss," they should land before non-incident work.

### Process improvements

1. **When a postmortem identifies a downstream bug, file it as P1 and pick it up first in the next session.** Don't let it linger as a generic "follow-up" alongside non-incident work. The mental category for "bug uncovered by an incident" should be the same as "ongoing incident" until it's fixed.

2. **Add an emergency-stop control to the Helios UI.** Phase-2 read-only-for-charging-actions has a real cost during incidents — the floor on response time is bounded by the user remembering which app has the working stop button. A "STOP CHARGING NOW" button wired to a known-good actuator chain (once the proper one exists) closes the gap. Until that's wired, the Helios activity feed should at least surface a cheat sheet of manual-stop options when stop attempts are failing.

3. **Track verification loops as a first-class concern in actuator design.** Every actuator function in `lib/{tesla,rivian,smartcar}/client.ts` should have a paired "did it actually work?" check. Today none do — `setBackupReserve`, `startCharging`, `stopCharging` all return `{success: boolean}` reflecting only API ack. Generalize the pattern.

## Action items

- [x] No-op `stopCharging` (`12a2d27`)
- [x] Wrap `getConfig()` in cron (`027e0a8`)
- [x] Postmortem (this document)
- [ ] **Wire proper Rivian `CHARGE_STOP` via vehicle-command API** (~2–4h; replaces the no-op)
- [ ] **Add post-stop verification loop** in cron route: after a stop action, on the next tick, log a discrepancy when `ev_w > 100 W`. Generalize to other actuators with observable state.
- [ ] **Audit other actuator functions** (`setBackupReserve`, `startCharging`) for the same "API-ack ≠ physical state" gap. Decide which deserve verification loops.
- [ ] **Update `app/AGENTS.md`** with the rule: schedule mutations are not imperative commands; actuator success requires observable-state verification.
- [ ] **Sweep the codebase for similar API-shape hypothesis comments** that haven't been verified against the canonical UI. (Search: docstrings of the form "this tells the car to X" without an "empirically verified" or "matches dashboard rendering" tag.)
- [ ] **Add an emergency-stop button to Helios UI** (Phase-2 lift, scope separately).

## How this incident strengthens the case study

The 4/29 incident demonstrated that Helios catches bugs honestly and fixes them in layers (tactical + structural). This 4/30 incident is a sharper version of the same shape: a hypothesis that *seemed* sound was falsified by production data within hours, and the response was disciplined — read the smoking-gun screenshot, locate the wrong code in 60 seconds, ship a defensive no-op before bed, write the postmortem the same evening.

The case study's "iteration story" already has a strong 4/29 entry. Adding 4/30 makes the pattern visible: not "we had one bad night," but "we have a working incident-response practice that catches the next one faster than the last." The 4/29→4/30 sequence in particular shows the cost of leaving a known-unknown unresolved (the "Investigate Rivian true-stop" item carried 24 hours and recurred), which is the exact lesson worth surfacing for an engineering audience.

If you update the case study to include this, the SOAR shape is roughly:

- **Situation:** Helios automation in production for ~6 days; 4/29 postmortem already filed; "Investigate Rivian true-stop" listed as a follow-up.
- **Obstacle:** Rivian's schedule mutation was being mis-used as an imperative stop. Active schedules with `amperage: 0` were rendered by the Rivian app as "Charge off-peak and save" windows. Every cron stop tick refreshed a permitted charge window that the car then honored at full rate during peak hours.
- **Action:** Detected during routine peak-hour dashboard check. Diagnosed in <5 min by reading the activity log + the Rivian app's own UI. Shipped a no-op `stopCharging` patch within ~10 min of diagnosis. Wrote the postmortem the same evening; opened follow-up todos for the proper command-API fix and a verification-loop pattern.
- **Result:** Trap can never be re-armed via cron. Honest "stop attempted, write failed" signal in activity feed. Generalized the lesson into a process improvement (open postmortem items get P1 triage) and an engineering principle (verify API hypotheses against the canonical UI before shipping).

---

*Filed alongside `2026-04-29-mock-data-incident.md`. Written within 30 minutes of incident close — the discipline, again, is the practice, not the artifact.*
