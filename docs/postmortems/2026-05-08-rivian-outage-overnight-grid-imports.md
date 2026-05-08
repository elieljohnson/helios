# Rivian backend outage during overnight charging — alarm gate's EV-specific blind spot

**Date:** 2026-05-07 evening through 2026-05-08 morning
**Severity:** P1 — actual cost ($3.11 of unintended grid imports during off-peak; would have been ~$5 at peak), eroded user trust ("can you investigate if helios had anything to do with the issue, and I didn't get alerts to show when we were draining the powerwall")
**Author:** Eliel Johnson (with Claude as co-builder)
**Status:** Shipped — plug-state arbitration fix (`d574e16`) prevents Rivian from overriding WC's physical-current reading; broadened Gate 1d alarm (`3f4ec52`) fires on grid imports regardless of EV-specific signal corruption.

---

## Summary

On the evening of 2026-05-07, the Rivian cloud backend entered a degraded state. Both the user and his wife confirmed they could not connect to the Rivian app. Helios's *Rivian (direct)* integration uses the same backend; during the outage it returned wrong or stale `chargerStatus` values. The status-assembly overlay then **overwrote the Wall Connector's correct "plugged" reading with Rivian's incorrect "unplugged" reading.**

The wife plugged the Rivian in around 18:50 PT. The car charged at the hardware level (no API path is involved — current flows when the cable connects), drew 11 kW until hitting its user-set 71% limit, and self-stopped sometime overnight. During the charging window, the Powerwall drained to its 20% reserve floor; once Tesla refused further discharge, **the grid imported the remaining ~8 kWh at off-peak rates ($0.36/kWh)**. Total measured cost on the day: $3.11.

No engine alarm fired. The previous day's Gate 1d (shipped 2026-05-07 morning to address that day's separate $1.34 grid-import incident) keyed on three conditions: `ev_w > 1 kW`, `pw_soc <= reserve_floor + 2%`, and `grid_w > 1 kW`. The first condition had a blind spot: when the snapshot's `ev_plugged_in` field was lying (overridden by Rivian to false), `ev_w` was also being silently zeroed. The alarm couldn't see the EV, so it never tripped.

This morning's session shipped two fixes that close both holes — the original failure mode (vendor data corruption silently invalidates plug state) and the second-order one (an EV-specific alarm has blind spots when EV data is corrupted).

## Timeline (PT)

**2026-05-07 evening:**
- **~18:50** — Wife plugs Rivian in. Car begins charging at 11 kW (hardware-level, no API).
- **18:55** — Helios snapshot reads `ev_plugged_in: true` momentarily, then back to false. Layer 1b plug-state-flap guard fires: *"Plug state changed this tick — confirming on next tick"*. Engine refuses to authorize anything based on a one-tick reading.
- **19:00** — Snapshot back to false. Engine sees: car not plugged in.
- **20:11, 20:15, 00:15, 00:20, 03:55** — Same flap pattern. Each "true" reading is followed within 5 minutes by "false" again. Layer 1b correctly suppresses every authorization on each one-tick true.

**Throughout the night:**
- Car charges in the background. Powerwall depletes from sunset target (~80%) toward reserve floor (20%) over several hours.
- Once PW hits 20%, grid imports take over for the remainder of the charge. Car self-stops when it hits 71% Rivian limit.
- Helios doesn't see any of this from the EV side. `ev_w` reads 0 in the snapshot because the Tesla WC overlay isn't running cleanly, and the Rivian-overridden `ev_plugged_in: false` makes the engine treat the EV branch as inactive.
- No engine alarm fires.

**2026-05-08 morning:**
- **05:00 → 07:55** — Normal morning-bridge logic runs. Engine writes `Set reserve to 10%` (morning bridge), then `Set reserve to 20%` (off-peak window opens). Nothing related to the EV.
- **~10:30** — User opens chat in frustration, reports the overnight situation: *"the powerwall down. Can you investigate if helios had anything to do with the issue, and I didn't get alerts."*

**Investigation:**
- **10:35** — Pulled `/api/actions` and `/api/status`. Daily cost reads $3.11. EV at 72%, target 71% (just past Rivian limit). Activity feed shows no Start/Stop pushes from yesterday evening through this morning — just the Layer 1b flap-guard "no action needed" entries. **Confirmed:** engine never authorized anything, never alarmed.
- **10:45** — Read `status.ts` overlay code for `ev_plugged_in`. Found the unconditional Rivian override at line 267:
  ```ts
  base.snapshot.ev_plugged_in = ev.isPluggedIn;
  ```
  No arbitration — Rivian always wins, even when WC's `power_w > 100` says current is physically flowing.
- **10:50** — Read previous Gate 1d code. Confirmed alarm required `ev_w > 1 kW`. With `ev_w` corrupted by the same vendor-failure that corrupted plug state, the alarm couldn't see anything.
- **11:00 → 11:55** — Designed and shipped both fixes.

## What we shipped

| Commit | Type | What |
|---|---|---|
| `d574e16` | fix | **Plug-state arbitration in status.ts.** When the Wall Connector observes physical current (`power_w > 100 W`) AND the Rivian overlay disagrees by reporting unplugged, keep WC's reading. Current at the connector is ground truth. The arbitration only engages on disagreement; when both providers agree (the normal case), Rivian's `chargerStatus` is still the authoritative source. Console.warn surfaces the disagreement to Vercel logs without silent suppression. |
| `3f4ec52` | fix | **Broadened Gate 1d alarm.** Drops the `ev_w > 1 kW` condition that the overnight incident bypassed. New conditions: PW at-or-below `reserve_floor + 2%` AND `grid_w > 3 kW` AND **same conditions on the previous tick** (anti-flap, eliminates false positives from HVAC inrush). Message becomes context-aware: when ev_w > 1 kW, body names the EV; when ev_w is 0 or unobserved, body is generic and surfaces "EV draw not directly observed (vendor data may be stale)" so the user knows something other than the EV might be drawing. |

Five new tests cover: alarm fires for EV case, alarm fires when ev_w is silently zeroed (the canonical overnight case), single-tick transient suppressed, PW comfortably above floor stays quiet, small grid imports below threshold stay quiet.

## Why the previous Gate 1d had a blind spot

Yesterday's morning incident (2026-05-07 ~07:30 PT) was an EV-specific failure: the projection authorized "PW drops to 0%" on a driving day, the car drained PW past floor, grid imports filled the gap. **In that incident, `ev_w` read correctly** — the Tesla WC was healthy, observed the 11 kW draw, surfaced it in the snapshot. The narrow Gate 1d (ev_w + PW + grid) caught that case correctly because every signal was clean.

Last night's incident was a **vendor-outage failure mode**, not an EV-specific failure mode. Rivian's backend was degraded. The `ev_plugged_in` field went corrupt. Then the engine's downstream EV-related fields (including `ev_w` attribution) all became unreliable on the same tick. **The narrow alarm couldn't see anything because its inputs were lying together.**

The lesson: alarms keyed on the same signal-domain as the failure they're trying to detect are fragile to coordinated failures of that domain. **The grid is a tell-truth signal:** PW at floor + significant grid import is unambiguously bad regardless of what's drawing. By keying on those two, the alarm becomes robust to EV-side data corruption — exactly the failure mode that bypassed yesterday's version.

## What we did right

- **Diagnosed the user's literal complaint correctly.** *"I didn't get alerts"* was the question; the answer was a specific named bug (the alarm's `ev_w` blind spot), not a hand-wave.
- **Two fixes addressing two distinct mechanisms.** Plug-state arbitration prevents the corruption from reaching the engine in the first place; broadened Gate 1d catches the failure mode even when corruption gets through. Defense in depth.
- **Anti-flap built into the broader alarm.** A wider alarm without a 2-tick guard would have produced HVAC-start false positives. The `prevSnapshot`-based two-tick check (already plumbed for Layer 1b) was reused with no new infrastructure.
- **The console.warn for disagreement** surfaces vendor-data-quality issues to Vercel logs without affecting engine behavior. Future investigations get a paper trail.

## What we got slightly wrong

- **Layer 4 structural fix per AGENTS.md is now genuinely overdue.** The "fail loudly when vendor data is unavailable" pattern would have prevented the entire failure mode at the source. The engine should be checking `sources.vehicle.status` and refusing to act on EV-related fields when the source isn't `"live"`. We've shipped four tactical defenses now (Layer 1, 1b, 1c, 1d, plus today's plug-state arbitration); each one closes a specific failure mode. The structural fix would close the class. Was P3 yesterday, P2 today, P1 tomorrow if anything else slips.
- **The plug-state-flap guard's logging.** Layer 1b only logs to the activity feed on signature changes. So a long flap window (last night was ~9 hours) only shows up as ~7 sparse entries with the same message. The user can't see "this has been flapping for hours." A counter-or-duration field on the activity row, or a warning-level entry when flap-count exceeds N over Y hours, would surface the persistent vendor-quality problem.
- **No "Rivian backend health" status indicator.** When the user says *"the Rivian app was down"*, the Helios dashboard has no equivalent signal. A subtle Settings indicator would let the user correlate vendor outages with engine behavior changes without needing to dig into the activity feed.

## Follow-ups

In rough priority order:

1. **Layer 4 structural fix per AGENTS.md** — promote to top priority. The pattern of vendor-data corruption silently propagating into engine decisions has now caused two real-money incidents in three days. Threading `sources.vehicle.status` through to `decideEvCharge` (refuse EV authorization unless source is live) would close the class.
2. **Plug-state-flap surfacing** — when Layer 1b fires repeatedly within a short window (e.g., 5 flaps in 1 hour), upgrade the activity-feed entry from info to warning, or write a separate alert. Lets the user see the underlying vendor-quality problem rather than just seeing sparse "no action" entries.
3. **Vendor health indicator on Settings** — small dot or status badge on the *Rivian (direct)* row that reflects recent fetch reliability (% successful fetches over last 1h). Different from the existing connection-state dot (which is binary). Lets the user see "Rivian backend wonky" without reading source.
4. **Plumb `pw_sunset_target_pct` through `recommendEvAction`** — still hardcoded to 80. Three sessions running, this dependency keeps showing up.
5. **Symmetric reserve-floor clamp on parked-day projection** — driving-day got the clamp yesterday; parked-day still uses live re-evaluation. Math hardening; not blocking but a smell.
6. **Settings UI for `home_geofence_radius_m` + DB column** — the geofence guard works today (Rivian direct connected); tunability is the only gap.
7. **Learned overnight-target feature** — `daily_summaries.morning_low_pw_pct` and `evening_high_pw_pct` are now writing rows. Revisit after another 2 weeks of data accumulation.

## Files changed across this session

3 files, 2 commits, 0 reverts.

```
app/src/lib/status.ts                          (plug-state arbitration)
app/src/lib/decideEvCharge.ts                  (Gate 1d broadened to grid_w + 2-tick check)
app/src/lib/decideEvCharge.test.ts             (5 tests rewritten + extended)
```

Test count 141 → 142 (+1 net; 5 tests new/rewritten, replacing 4 existing).

## Validation

The fix is forward-looking — both new tests cover synthetic scenarios that exactly mirror last night's. **The actual validation is the next time Rivian's backend has a hiccup.** Expected behavior in that case:

- Engine continues to read plug state correctly because WC's physical-current observation overrides Rivian's stale data.
- If something still goes wrong (WC overlay also fails, projection authorizes a borderline plan, etc.), Gate 1d fires within 10 minutes (2 ticks) of grid imports starting.
- Push body names the failure: *"Powerwall at reserve floor — car charging from grid"* OR *"Powerwall at reserve floor — grid imports active"* with kW numbers and the cost arithmetic.

If those don't fire on a future similar event, the engine isn't reading the new conditions correctly or the threshold is too high — would surface as either a missed alarm (debug from `/api/actions` showing PW at floor + grid > 3 kW with no action entry) or a false alarm (investigate which load was firing).

## Cross-references

- `AGENTS.md` — Production data discipline (this incident's class is the canonical case for the structural fix)
- `docs/postmortems/2026-04-29-mock-data-incident.md` — original instance of "stale vendor data masquerading as real" — different vendor (Tesla), same pattern
- `docs/postmortems/2026-05-06-phantom-start-and-projection-bug.md` — adjacent vendor-data class: Rivian/WC plug-state flapping during user's wife's irregular morning
- `docs/postmortems/2026-05-07-reserve-floor-grid-imports.md` — yesterday's session, including the original Gate 1d that this session broadens
- `memory/feedback_external_api_quotas.md`, `memory/feedback_query_command_state.md` — vendor-data hygiene memos that informed this session's diagnosis
