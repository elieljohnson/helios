# Overnight charging without daylight — parked-day projection had no sunrise gate

**Date:** 2026-05-09 morning
**Severity:** P1 — actual cost ($0.49 of unintended grid imports during off-peak; would have been ~$1.50 at peak rates), continued erosion of user trust ("the charge recommendation should have been more conservative and it should have sent an alert when we were going to pull from grid")
**Author:** Eliel Johnson (with Claude as co-builder)
**Status:** Shipped — pre-sunrise daylight gate on parked-day projection (`401dee5`), Gate 1d alarm stays high-priority regardless of EV state (`9f45686`).

---

## Summary

At 00:10 PT, the engine fired *"Start EV charging now — Charge to 83%, Powerwall projected at 100% by sunset."* The user's wife followed the recommendation. The car charged at 11 kW from the Powerwall through the overnight hours. Solar didn't appear until ~07:00 PT, but by ~04:00 PT the Powerwall had drained from ~93% to its 20% reserve floor. Tesla refused further discharge; **grid imports filled the rest of the charging window at $0.36/kWh**. Total cost: $0.49.

The Gate 1d alarm — designed to catch exactly this situation — fired correctly at 08:20 PT. But by then the EV had self-stopped (reaching its 83% Rivian limit at 08:10 PT), and `recommendEvAction` saw `ev_charging: false` and demoted the alarm from `priority: high` to `priority: info`. The activity feed entry was written; **no push reached the user's phone**.

Two distinct bugs combined: the projection authorized a plan whose PW trajectory dipped below reserve floor, and the alarm that was supposed to catch the resulting grid imports got silenced because the EV had stopped drawing by the time it fired.

This is the third overnight grid-import incident in three days. All three trace to the same structural pattern: **the integral projection is honest about endpoints but doesn't model trajectories.**

## Timeline (PT)

**Wednesday 2026-05-08 evening (preceding):**
- ~17:10 — Wife plugs in. Layer 1b plug-state-flap tick fires correctly. EV starts charging via the new Gate 2.5 path.
- ~18:00 — EV reaches 83%, charging complete. Sunset cutoff stops further activity. PW around 93%.

**Thursday 2026-05-09:**
- **00:10** — Engine pushes *"Start EV charging now — Charge to 83%, Powerwall projected at 100% by sunset."* Solar producing 0 W. The integral projection averages 19 hours of future solar against immediate PW drain and authorizes; signature `start:high:limit83` fires the push.
- **04:25** — Same push fires again with limit 80% (signature `start:high:limit80` after a brief recommendation flip).
- **04:30** — Push at limit 83% again. Three pushes in 4 hours, all pre-dawn.
- **00:10–07:00** — Wife taps "Start" in the Rivian app, charging proceeds at 11 kW. PW drains continuously (no solar to refill).
- **~04:00** — PW hits the 20% reserve floor. Tesla refuses further discharge.
- **04:00–08:10** — Grid imports cover the EV draw at off-peak ($0.36/kWh).
- **06:40** — Morning bridge fires (solar 0.2 kW < home 0.7 kW), reserve lowered to 10% so PW can supply house bridge.
- **07:00 onwards** — Solar starts producing meaningfully; EV continues charging from solar + grid.
- **08:10** — EV reaches 83% Rivian limit, self-stops.
- **08:20** — Gate 1d alarm fires: *"Powerwall at reserve floor — grid imports active"*. Activity feed entry written. **No push** because `ev_charging: false` triggered the info-priority demotion path.
- **~10:30** — User in chat: *"the engine should have been more conservative... should have sent an alert when we were going to pull from grid."*

## What we shipped

| Commit | Type | What |
|---|---|---|
| `401dee5` | fix | **Pre-sunrise daylight gate on parked-day projection.** Refuses to authorize EV charging when `solar_w < 200 W`. The driving-day path has had this gate since the start; the parked-day path didn't. Match the threshold so behavior is symmetric across both paths. The gate trips ~10–30 min after sunrise depending on conditions, defers all overnight authorizations until then. Three new tests cover the overnight refusal, the noise-floor case, and the daylight-pass-through case. |
| `9f45686` | fix | **Gate 1d alarm stays high-priority regardless of EV state.** Detect the Gate 1d reason text (`reserve floor` or `grid imports active`) in `recommendEvAction` and force `priority: high` even when `ev_charging: false`. Body and title adapt: when the EV is drawing, the push is "Stop EV charging now — grid imports happening"; when the EV is idle, it's "Grid imports happening — Powerwall at reserve floor. EV idle but grid is still pulling X kW. Check what's running — HVAC, hot tub, anything that just kicked on." Two new tests for both branches. |

Five new tests total (148 → 153). Typecheck clean.

## Why the projection authorized overnight charging

The integral budget formula in `projectParked`:

```
available_for_ev = solar_remaining − house_remaining + (pw_now − sunset_target)
```

At 00:10 PT, with sunset ~19:30 PT today, the integration window is **19+ hours**. With a sunny forecast (today was projected ~91 kWh), `solar_remaining` came out to ~75 kWh. `house_remaining` was ~30 kWh. PW headroom (`pw_now − sunset_target`) was ~5 kWh. So `available_for_ev = 75 − 30 + 5 = 50 kWh` — comfortably more than the EV's 33 kWh gap to its 83% limit.

**The math is internally honest about endpoints.** PW does land near sunset target by sunset, given the forecast. But the formula has zero awareness of the **trajectory** between now and sunset. At midnight, the engine averaged 19 hours of future solar against immediate PW drain. Reality: PW drains at 11 kW for 6 hours straight before solar even appears, hitting reserve floor along the way, with grid imports filling the gap.

This was called out as a follow-up in the May 7 postmortem:

> "The reserve-floor clamp is only on the driving-day branch. Parked-day projection doesn't enforce the same floor. The argument is 'live re-evaluation catches it on the next 5-min tick' — true today, but it's not a math-level guarantee, it's a runtime hedge. A symmetric fix on parked-day (clamp pw_delta_to_target_kwh against the floor) would be cleaner. Worth a small follow-up."

I noted it. I didn't ship it. It bit two days later.

## Why Gate 1d's alarm didn't fire a push

The alarm DID fire — at 08:20 PT, it correctly detected `pw_soc <= 22 (floor + 2% buffer)` AND `grid_w > 3 kW` AND prev tick satisfied the same. The engine returned `action: stop` with reason "Powerwall at reserve floor — grid imports active".

But by 08:20 the EV had self-stopped 10 minutes earlier (reaching its 83% Rivian limit). `snapshot.ev_charging` was `false`. `snapshot.ev_w` was 0. `recommendEvAction`'s `stop` branch fell through to:

```ts
return {
  kind: "noop",
  priority: "info",
  title: "EV idle — engine recommends stop",
  body: decision.reason,
  ...
};
```

`priority: info` → no push fires. The activity feed entry was written; the user's phone stayed silent.

The bug-shape: the alarm priority was implicitly conditional on the EV being the thing drawing. But Gate 1d's alarm signals "PW is exhausted AND grid is paying for whatever's running" — the cost event is real regardless of *who*. House is at the reserve floor either way; HVAC, hot tub, water heater could just as easily be the consumer.

## Why this kept happening

Three overnight grid-import incidents in three days, all from the same structural class:

| Date | Cost | Specific cause | Class |
|---|---|---|---|
| 2026-05-07 morning | $1.34 | Driving-day projection didn't clamp at reserve floor | Trajectory blindness |
| 2026-05-07 overnight | $3.11 | Plug-state arbitration bug + Gate 1d EV-specific condition | Vendor data + alarm blind spot |
| 2026-05-09 morning | $0.49 | Parked-day projection no daylight gate + Gate 1d alarm priority demoted | Trajectory blindness + alarm blind spot |

Each fix has been tactical: clamp this term, broaden that gate, add this threshold. The structural answer is the path-aware projection — walk forward in 1-hour buckets and refuse any plan whose simulated PW SoC dips below `reserve_floor + safety_margin` at any point.

The May 7 postmortem named this. The May 8 postmortem named this. Today's incident demonstrates that tactical patches don't substitute for the structural fix forever — each one closes a specific hole; the next one finds a slightly different angle.

## What we did right

- **Diagnosed the morning's behavior precisely from the activity feed**, even with `/api/actions` recovered after yesterday's migration. The feed showed three pre-dawn Start pushes with their timestamps; the timeline was reconstructable without instrumentation.
- **Two distinct fixes for two distinct bugs.** Daylight gate stops the bad recommendation upstream; alarm priority fix catches the failure mode if anything still slips through. Defense in depth.
- **Idle-case alarm copy explicitly tells the user "look beyond the EV."** The alarm's job is to surface unexpected ongoing imports, not to nag about the car specifically. Body says *"EV idle but grid is still pulling X kW. Check what's running — HVAC, hot tub, anything that just kicked on."* Honest about the situation.

## What we got wrong (again)

- **Knew the parked-day reserve-floor gap was a problem, didn't ship the fix.** Promised "small follow-up" in the May 7 postmortem. Didn't do it. Got bitten exactly the way the comment described. The lesson: when a postmortem lists a "small follow-up" that's protecting against a known failure mode, ship it that session, not "soon."
- **The Gate 1d priority demotion was a blind spot.** I built the alarm specifically as "the runtime backstop for projection errors" but didn't think through the case where the projection error fires the alarm AFTER the EV has stopped (because the EV stopping is one of the natural endings to a charging session). The alarm wasn't designed for "ongoing grid imports without a car as the proximate cause" — but it should have been.
- **Tactical patches don't replace structural fixes.** Each tactical fix is technically correct, but the cumulative pattern suggests the projection's trajectory blindness is the durable issue. The path-aware simulation is overdue.

## Follow-ups

In rough priority order:

1. **Path-aware projection** — walk forward hour-by-hour, simulate PW SoC under the proposed plan, refuse any plan whose PW dips below `reserve_floor + safety_margin` at any point. This is the structural answer to all three recent incidents. Probably 1–2 days of work; defers further tactical patches.
2. **Plumb `pw_sunset_target_pct` through to `recommendEvAction`** — still hardcoded `80`. Now four sessions running.
3. **DB column for `home_geofence_radius_m`** — Settings exposure, blocked on migration.
4. **Layer 4 structural fix per AGENTS.md** — `sources.vehicle.status` threaded through to engine. Pattern of "vendor data corruption silently propagates" is now P1.
5. **Yesterday's discovered `rowToSnapshot` bug + migration 0019** — fixed last night (same session as today's diagnosis). Worth noting in a separate brief postmortem so the bug-history is traceable; mostly closing the loop on the day-old "Gate 2.5 doesn't fire pushes" symptom.

## Files changed across this session

3 files, 2 commits, 0 reverts.

```
app/src/lib/decideEvCharge.ts             (parked-day daylight gate)
app/src/lib/decideEvCharge.test.ts        (3 new tests)
app/src/lib/recommendEvAction.ts          (Gate 1d priority fix)
app/src/lib/recommendEvAction.test.ts     (2 new tests)
```

Test count moved from 148 → 153 (+5).

## Validation

The fix is forward-looking. **The next overnight is the test.** Expected:

- Wife plugs in at any time after sunset → no Start push fires until solar starts producing (~06:30 PT depending on time of year).
- At sunrise, daylight gate passes; projection runs; if PW is high and forecast is positive, Start push fires for the morning charging window.
- During morning charging: PW is being supplied by both solar AND its own charge, so the trajectory dip is shallow and stays well above reserve floor.
- If anything still goes sideways: Gate 1d alarm fires high-priority push regardless of whether the EV is currently drawing.

If overnight charging happens *anyway* despite the gate (manual override, projection bug we missed), the alarm should catch it within 10 min of grid imports starting and surface the situation honestly.

## Cross-references

- `AGENTS.md` — Tariff-environment assumptions (today's gate cites NEM 3.0 / NBT explicitly)
- `docs/postmortems/2026-05-07-reserve-floor-grid-imports.md` — May 7 morning incident; this is the postmortem that named the parked-day gap as a follow-up
- `docs/postmortems/2026-05-08-rivian-outage-overnight-grid-imports.md` — May 8 overnight; the ev_w-blind-spot ancestor of today's alarm-priority bug
- `docs/postmortems/2026-04-30-rivian-schedule-trap.md` — original "engine acts on math whose closure depends on grid imports" pattern, different mechanism
