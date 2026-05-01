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
| EV draw during phase-1 incident window (~50 min, peak rate) | ~9.4 kWh from PW |
| EV draw during phase-2 (post-"manual stop" autonomous resume, ~25 min) | ~4.5 kWh from grid, all at peak rate ($0.58/kWh) |
| Total EV grid imports today | ~19.4 kWh (38% of 51 kWh delivered) |
| Net daily cost at end of incident | $7.39 (was $6.08 at first detection; ~$1.30 of avoidable peak imports during phase 2 alone, plus indeterminate phase-1 contribution) |
| Powerwall trajectory | 80%+ → 72% in phase 1; sat at reserve floor (60%) through phase 2, contributing zero relief because the engine had raised reserve for peak guard before automation was disabled |
| User intervention | Two manual stops required; second one only stuck after physical unplug / charge-limit lowered |
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
| **19:30** | User pressed Stop in Rivian app, toggled the "Daily 7:24pm–12am" schedule off in Rivian app, and disabled automation in Helios Settings. EV draw confirmed at 0 kW. Bleeding *appeared* stopped. |
| **19:34** | Tactical fix (`12a2d27`): `stopCharging` is now a no-op. Returns `{success: false}` so cron logs "Stop EV charge (write failed)" honestly. 66 tests pass. |
| **19:35** | Bonus fix (`027e0a8`): wrapped `getConfig()` in cron route — unrelated in-flight work that paused for this incident, shipped together because the tree was already clean. |
| **~19:40** | Postmortem v1 drafted (this document, pre-resumption section). |
| **~19:50** | EV charging resumed at 11.1 kW from grid. Cause: with the schedule disabled and the cable still connected, Rivian's *default* behavior for a plugged-in car with no active schedule is to charge to its set limit (80%) — the v2 failure mode we'd already documented in the `stopCharging` history. The car had been at 73% when the user pressed Stop; the autonomous "resume" took it to 74% over ~25 min before re-detection. |
| **19:55** | User reopened the Helios dashboard, saw PW at 60% (= reserve floor, can't help), grid importing 12.7 kW, EV drawing 11.1 kW. Daily cost $7.32 (up from $6.08 at 19:25). |
| **20:02** | User unplugged the cable / lowered Rivian charge limit. EV draw confirmed at 0 kW. Daily cost peaked at $7.39. Total post-"manual stop" damage: ~$1.30 of grid imports during ~25 min at peak rate, with PW unable to assist because it was sitting at the engine-set 60% peak-guard reserve. |
| **~20:10** | Postmortem updated with the resumption sequence (this section). |
| **2026-05-01 06:34** | Morning check. User-set charge limit (lowered below current SoC last night as a workaround stop) found reverted to 80%. Helios confirmed innocent — activity log empty since 19:30 yesterday, no `setChargeLimit` function exists in the codebase. Rivian's backend reverted the manual change overnight, presumably distinguishing a session-level limit (per-charge override, resets on wake/sync) from a profile-level limit (persists). The disabled "7:29-12:00" schedule entry also still visible in the app — toggle off, residual from the last cron tick before automation was disabled. Schedule re-appearance is *not* new autonomy; charge-limit reset *is*. Adds a third Rivian autonomous behavior to document alongside (1) schedule-as-permitted-window and (2) default-charge-to-limit. |

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

6. **Helios has no durable stop authority over the Rivian — *even when fully disabled.*** This is the sharper version of factor #5, uncovered when the charge resumed at 19:50 despite (a) the user having pressed Stop in the Rivian app at 19:30, (b) the user having toggled the "Daily 7:24pm–12am" schedule off, and (c) Helios automation being switched off entirely. With no active schedule, the cable still connected, and the car below its set charge limit, **Rivian's default autonomous behavior is to charge to limit at full rate**. Pressing Stop in the Rivian app is a soft pause; toggling the schedule off removes Helios's (broken) influence but also removes any user-set charge window; without either, the car falls through to its built-in default. The implication is significant: *every plug-in event today has an open window where the Rivian will charge from grid at whatever the current rate is, until either a working schedule is in place or someone manually intervenes.* Helios's no-op patch (`12a2d27`) prevents Helios from making this *worse* by adding phantom permitted-charge windows; it does not give Helios the ability to make it *better*. Until the proper one-shot `CHARGE_STOP` command lands (todo #4), the system has zero authoritative way to stop the Rivian — the user's only durable stops are physical unplug or lowering the Rivian's set charge limit at-or-below the current SoC.

7. **The peak-hour reserve guard was a NEM 2.0 holdover, not a Phase-2 oversight.** The single biggest economic finding of the night was *unrelated* to the Rivian stop bug. The user surfaced it during the post-incident debrief: "with no Helios we would have drained the battery, and frankly the rates are lower later even if the house was running on the grid." Pre-fix, `decide.ts` raised PW reserve to `reserve_peak_pct` (default **60%**) during peak hours, with the comment *"to preserve stored energy."* That rule was economically rational under **NEM 2.0**, where peak-rate exports paid retail (~$0.58/kWh) and the user could arbitrage by saving PW for peak export. Under **NEM 3.0** (the user's current tariff), exports pay a flat ACC rate of ~$0.04/kWh — the arbitrage is gone, and the cost-rational play during peak is to discharge PW into home/EV loads to *avoid* the $0.58/kWh import. The phase-2 incident was the textbook case: PW sat at exactly 60% while home + EV demanded 12.7 kW; PW couldn't help, all 12.7 kW imported at peak rate. With a 20% reserve floor, the PW had ~16.2 kWh of headroom — more than enough to cover the entire phase 2 plus the rest of the EV charge. **Avoidable cost tonight from this rule alone: ~$6.** **Cumulative summer-season cost (~150 peak days/year × ~$6/day): ~$900/year.** Fixed in commit `<this session>`: peak/mid-peak reserve raises removed; `reserve_peak_pct` config knob preserved as opt-in for users on tariffs where the old behavior still pencils. New `AGENTS.md` rule: **tariff-dependent rules must cite their tariff and arbitrage by name** so a future migration can identify them mechanically. This is the lesson with the largest dollar-impact-to-line-of-code ratio in the project so far.

## Detection

User noticed at 19:23 PT during a routine dashboard check at the start of peak hours, when the COST card and PW SoC indicator were visibly going the wrong direction. No automated alert fired. The 4/29 postmortem already flagged "no data-health surface in the dashboard"; the data-health badge shipped earlier the same day in commits `877154b` + `2f63c20` does not yet cover the actuator-state mismatch class of bug (it tracks source freshness, not "the car ignored our stop command").

## Resolution

### Tactical (shipped in `12a2d27`)

The patch caps the *Helios-induced* damage. It does not fix the underlying lack-of-stop-authority problem (see contributing factor #6 above). The user's only durable stops between now and the proper command-API fix are:

- **Unplug the cable** (guaranteed; ~30 sec)
- **Lower the Rivian's set charge limit to at-or-below the current SoC** (Rivian app → Charging → Charge Limit). The car stops because the at-target gate fires immediately.
- *Not* "press Stop in the Rivian app" — that's a soft pause and the autonomous resume can fire within minutes.

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

5. **"Disabled" automation is not the same as "no exposure."** When an upstream system has autonomous default behavior (Rivian's charge-to-limit, Tesla's PW operating mode, etc.), turning *our* automation off does not turn *their* defaults off. The mental model "I disabled Helios, the system is in manual mode" is wrong. The accurate model is "I disabled Helios, the upstream systems are in *their* default modes, which may or may not be what I want." Any shutoff procedure for Helios needs to include explicit guidance on what each upstream will do in the default state. Until then, "automation off" is a partial mitigation, not a safe state.

6. **Tariff-environment assumptions are not invariants.** Cost-minimization rules depend on the user's specific tariff. When the tariff changes — by user-initiated plan switch, by utility revision, or by regulatory regime supersession (NEM 2.0 → NEM 3.0) — every rule that compares "saving for later" against "spending now" needs to be re-derived from the new economics. Carrying forward NEM-2.0-era rules under NEM 3.0 cost the user ~$900/year in this case, and was invisible until someone reconstructed the price comparison by hand. The rule going forward (now in `AGENTS.md`): tariff-dependent logic must name its tariff and the specific arbitrage it captures, in a comment, at the call site. A grep for "preserve" or "save for" without a tariff citation is now a code smell.

### Process improvements

1. **When a postmortem identifies a downstream bug, file it as P1 and pick it up first in the next session.** Don't let it linger as a generic "follow-up" alongside non-incident work. The mental category for "bug uncovered by an incident" should be the same as "ongoing incident" until it's fixed.

2. **Add an emergency-stop control to the Helios UI.** Phase-2 read-only-for-charging-actions has a real cost during incidents — the floor on response time is bounded by the user remembering which app has the working stop button. A "STOP CHARGING NOW" button wired to a known-good actuator chain (once the proper one exists) closes the gap. Until that's wired, the Helios activity feed should at least surface a cheat sheet of manual-stop options when stop attempts are failing.

3. **Track verification loops as a first-class concern in actuator design.** Every actuator function in `lib/{tesla,rivian,smartcar}/client.ts` should have a paired "did it actually work?" check. Today none do — `setBackupReserve`, `startCharging`, `stopCharging` all return `{success: boolean}` reflecting only API ack. Generalize the pattern.

## Action items

- [x] No-op `stopCharging` (`12a2d27`)
- [x] Wrap `getConfig()` in cron (`027e0a8`)
- [x] Postmortem v1 + phase-2 update (`02624e0`, `c5e1d73`)
- [x] **Remove NEM-2.0 peak/mid-peak reserve guards** from `decide.ts`. Default tariff (NEM 3.0/NBT) now lets PW discharge through peak. `reserve_peak_pct` config knob preserved as opt-in. Tests updated; new test asserts mid-peak holds at floor too. `AGENTS.md` rule added on tariff-dependent logic. *(this session)*
- [✗] **Wire proper Rivian `STOP_CHARGING` via vehicle-command API** *(code written 2026-05-01; live test failed 2026-05-01 ~22:42 PT; closed as not viable for our deployment shape)*. The five v5 feature commits sit local-unpushed and **will not be pushed** — the design assumes cloud-only HMAC auth is sufficient, but the live test proved BLE pairing is mandatory. Failure signature: `sendVehicleCommand({ command: "STOP_CHARGING" })` returned `success: true` with a valid commandId; subsequent `getVehicleCommand(id)` returned `state: 4, responseCode: 1047` (terminal failure); ev_w stayed at ~11.4 kW throughout a 6-minute observation window. Control test: user's BLE-paired iPhone stopped the car instantly via the Rivian app's STOP_CHARGING flow — confirms the command path works for paired devices, ours just isn't paired. Per https://rivian-api.kaedenb.org/ble/enroll/: *"the phone is authorized to pair with the Rivian Phone Key peripheral. [After pairing,] the phone will then be able to send commands to the vehicle."* Cloud-side `EnrollPhone` is necessary but not sufficient. Helios runs on Vercel — no Bluetooth, no path to pair, no remote workaround in the API. **Strategic implication**: Rivian's command-API path requires a v6 architecture (local always-on daemon on user's home network, BLE-paired with the car, exposing an HTTP endpoint Helios cron can hit). Substantial new surface area; not pursuing unless Smartcar V3 actuators also fail (they don't have a BLE requirement).
- [x] **Add post-stop verification loop** in cron route *(2026-05-01; commit `8c988f3`, kept local pending push)*. Pure function in `lib/verifyEvAction.ts` reads the recent actions, finds the most recent successful stop, and logs a charge-action with `ok: false` and reason "stop ack'd Ns ago but car still drawing N kW" if `ev_w > 100 W` within the 60–600 second window. Voids itself when an intervening start fires (engine flipped its mind) or a verification-failure entry already exists for this stop (no duplicate logs). 11 unit tests pin the state machine. Independently valuable for the Smartcar V3 actuator path that becomes the only working stop authority post-2026-05-01 finding. The pure function survives the v5-Rivian dead-branch and is the salvageable piece of the v5 work.
- [ ] **Audit other actuator functions** (`setBackupReserve`, `startCharging`) for the same "API-ack ≠ physical state" gap. Decide which deserve verification loops.
- [ ] **Update `app/AGENTS.md`** with the rules: (a) schedule mutations are not imperative commands; (b) actuator success requires observable-state verification; (c) "automation off" is not a safe state — document upstream default behavior for every integration.
- [ ] **Sweep the codebase for similar API-shape hypothesis comments** that haven't been verified against the canonical UI. (Search: docstrings of the form "this tells the car to X" without an "empirically verified" or "matches dashboard rendering" tag.)
- [ ] **Add an emergency-stop button to Helios UI** (Phase-2 lift, scope separately). Floor on incident response time today is bounded by the user remembering which app has a working stop control; today, that's "Tesla Wall Connector → unplug" because Rivian's app-level Stop has been demonstrated to be a soft pause.
- [ ] **Document upstream-default behavior** for each integration (Tesla PW operating modes when reserve writes stop; Rivian charge-to-limit when no schedule active; Smartcar/Wall Connector defaults; Enphase if it had any actuators) — this becomes part of the Settings → "Automation off" tooltip and the postmortem reference appendix.
- [ ] **Add a "stop checklist" to the Activity feed when the engine fires a stop and the next tick still shows EV draw**, so the user has the manual-stop options surfaced inline rather than having to remember them.
- [✗] **Smartcar V3 actuator migration** *(code shipped 2026-05-01 morning; live test failed 2026-05-01 ~10:00 PT; closed as not viable for our deployment shape, same root cause as Rivian leg)*. Migration shipped end-to-end in commits `49ebf09` (initial), `498164d` (M2M auth refactor), `a56e76f` (live-mode filter), `cae2ef9` (correct V3 actuator paths/bodies). V3 paths are correct (`/v3/vehicles/{id}/commands/charge/{start,stop,set-limit}`, JSON:API envelope, integer percent for set-limit). V3 reads via M2M token + `sc-user-id` header work flawlessly end-to-end. **But all three actuator commands return `409 VEHICLE_STATE / DEVICE_PAIRING_REQUIRED`**: *"We're unable to perform the request as a mobile device has not been paired with the vehicle."* Smartcar's official API inherits the same OEM-level pairing constraint that blocked the Rivian unofficial command path. The user's iPhone IS paired (manual stops via the Rivian app work instantly), but Smartcar requires its own recognized pairing handshake to act as command authority — there is no remote-pairing primitive on either path. **Strategic finding**: cloud-only charging-command authority for the Rivian R1S is not achievable through any cloud API available to this deployment. Both the unofficial Rivian path (BLE pairing) and the officially-supported Smartcar path (DEVICE_PAIRING_REQUIRED) are gated by the same physical-pairing requirement.
- [✗] **v6 Rivian-via-local-BLE-daemon — empirically closed 2026-05-01.** Feasibility spike ran end-to-end against the actual R1S Gen 2 with the in-vehicle "Set up your phone key — Helios / Waiting for Helios" prompt actively displayed. The bretterer/rivian-python-client BLE scan returned **no Rivian peripheral whatsoever**, despite the laptop being physically inside the car, Bluetooth permission granted to Terminal, and 15 other BLE devices visible (iPhone, Apple Watch, luggage trackers). Best inference: **Gen 2 R1S uses Apple Car Key**, not the legacy generic-BLE phone-key protocol the bretterer lib targets. Apple Car Key uses Apple Wallet's secure-enclave-bound provisioning, which cannot be initiated from a laptop or any non-Apple-enclave-holding device. There is no third-party library equivalent because the secure-element provisioning is architecturally locked. **All three plausible paths to charging-command authority on this car are now empirically closed**: (1) Rivian cloud command API, (2) Smartcar V3 commands, (3) local BLE via bretterer. Spike artifacts committed at `app/scripts/v6-spike/` as evidence + templates. Strategic answer is now Option B: read-only with manual-action UX. The decision-engine IP is the load-bearing value; the actuation layer is the gate that the OEM owns.

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
