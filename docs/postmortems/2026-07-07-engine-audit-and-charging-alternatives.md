# Engine audit + charging-automation alternatives (with Fable)

**Date:** 2026-07-07
**Severity:** N/A — a code audit and a research/exploration session, not an incident.
**Author:** Eliel Johnson (with Claude, and Fable as a second model on the alternatives)
**Status:** Three engine bugs fixed, tested, and deployed (`03d786a`, `fad455a`). Charging-automation exploration reached a definitive negative on remote discovery; one live experiment remains parked. The Rivian spike script is committed (`b027346`, `bfdc95e`).

---

## Summary

Two threads. First, a logic audit of the decision-critical code turned up three real bugs — all fixed with regression tests and shipped. Second, a fresh attempt (with Fable as a second mind) to find a way to automate the Rivian R1S Gen 2 charging that hadn't already been ruled out. The exploration produced a clear, reusable map of what is and isn't possible, and narrowed the whole problem to a single un-run experiment plus one hardware path that is guaranteed to work.

---

## Part A — engine audit (fixed + deployed)

Three bugs, most-severe first. All fixed with tests that fail on the old code, verified (`tsc` clean, 162 tests), and deployed.

1. **`decide.ts` double-counted the EV in surplus** (`03d786a`). `surplus_kw = solar − home_w − ev_w`, but `home_w` (Tesla `load_power`) already includes the EV (AGENTS gotcha #6). The extra `− ev_w` understated surplus by the EV's draw, which silently disabled the "big surplus while EV charging → bank it in the Powerwall" guard exactly when the car was charging — the only time it fires. Fixed to `solar − home_w` (split house-only + EV). A green test had encoded the wrong formula and the guard test used `ev_w = 0`, so nothing exercised the bug; both replaced with `ev_w > 0` cases.

2. **`pw_reserve` could read the mock seed while the Powerwall showed "live"** (`03d786a`). `backup_reserve_percent` comes from a nested `site_info` call with its own try/catch; if it fails while `live_status` succeeds, the engine compared its target against a phantom reserve and could skip a needed write forever. Added optional `pw_reserve_live`; `status.ts` sets it `false` on that failure and `decide()` then forces the write (idempotent, so strictly safer than trusting a stale value).

3. **Push classification keyed on `reason` text across a file boundary** (`fad455a`). `recommendEvAction` regex-matched `decision.reason` to route pushes — a reword in `decideEvCharge` would silently mis-classify (the 5/09 failure class). Added a structured `stopKind` on `EvDecision`, pinned by tests on both the producer and consumer side.

**What was sound:** `status.ts` data-discipline (the 4/29 lesson correctly applied — pessimistic provenance, `markUnavailable` in catch blocks). The EV engine keys off `grid_w`/`solar_w` directly and defers trajectory math to `projectPwTrajectory`, so it does not repeat the double-count. **Not deeply audited:** `projectPwTrajectory.ts` internals (well-tested, sampled only), `db.ts`, the provider clients.

## Part B — charging automation: the map after this session

### The reframe

Every dead path tried to make the *car* obey a command. The live paths either gate the *electrons* or use the one car surface that doesn't need pairing. The strategic one-liner: **stop trying to be the car's key; become its power company.**

### What is now definitively established

- **Car-command surface is dead.** Rivian `sendVehicleCommand` (including the old command-based `setChargeLimit`, added in `87d4743`, reverted in `7ecb23d`), Smartcar V3 commands, and local BLE all hit the Apple Car Key pairing wall. Four independent closures. Do not re-attempt.
- **The Rivian *schedule* surface writes cloud-only WITHOUT pairing** — proven by the 4/30 trap. But the amperage field was IGNORED at `0` (the car fell back to the wall connector's 48 A). Whether a *nonzero* amperage throttles is the one open cloud-only question, and only a live write can answer it (introspection can't tell you whether the car *honors* a value at runtime).
- **Remote schema discovery is a dead end** *(new this session)*. Rivian's gateway (`rivian.com/api/gql/gateway/graphql`) **blocks GraphQL introspection** (`__schema`/`__type` → "Error in GraphQL validation") **and masks all field-level validation errors** with the same generic string. So neither introspection nor name-probing can reveal whether a non-command charge-limit mutation exists. A future session should NOT re-attempt schema discovery against this gateway.
- **The Tesla Wall Connector is read-only** (confirmed by `tesla-wc-spike*.ts`). No start/stop/amperage surface, local or cloud. Commanding the existing charger is dead; *replacing* it is not.
- **A local always-on bridge already exists** — `scripts/wc-poller.ts` runs on a home box, polls the Wall Connector's local API, and pushes to Vercel. So "needs home hardware / a local bridge" is a small step, not a cold start.

### Fable's ranked alternatives (the roadmap)

1. **Supervised nonzero-amperage schedule write test** — the last cloud-only shot. Half a day, zero hardware, reuses working auth. Likely negative (amperage probably ignored as at 0) but a free win if it lands. *(Parked — see below.)*
2. **Schedules used constructively** — engine writes tomorrow's solar window as the car's *permitted* charge window. Cloud-only, coarse (all-or-nothing 48 A), no throttle. Interim influence if #1 fails.
3. **Replace the EVSE with a smart charger** (OpenEVSE / Emporia / Wallbox) — **the authoritative fix.** The J1772/NACS pilot signal is binding on the car by standard, so the pairing wall stops mattering and you get continuous amperage control for real solar-matching. ~$400–700 + electrician; uses the existing bridge box. Guaranteed by physics.
4. Smart contactor upstream of the charger — hard cut, no throttle; strictly worse than #3.
5. Paired spare-iPhone UI-automation bridge — fragile; last resort.
6. Powerwall-side shaping — hopeless (the charger is just a house load).

### The parked experiment (resume point)

`scripts/rivian-schedule-spike.ts` — single-run login (prompts for the MFA code inline), then Phase 1 (introspection → falls back to name-probe; both now proven dead ends). **Phase 2 — the supervised nonzero-amperage write — is deliberately un-wired.** To resume:

- Reconstruct the schedule write from the known-good reference: `scripts/rivian-stop-probe.ts` has the exact payload shape (`operationName: "SetChargingSchedule"`, `variables: { vehicleId, chargingSchedules: [...] }`, each schedule `{ weekDays: <day-name strings>, startTime, duration, location: {latitude, longitude}, amperage, enabled }`). The mutation *string* `SET_CHARGING_SCHEDULES_MUTATION` was reverted out of the tree — pull it from git blob `87d4743:src/lib/rivian/auth.ts`.
- vehicle-state readback: `VEHICLE_STATE_QUERY` in `src/lib/rivian/client.ts` (`batteryLevel`, `chargerState`, `gnssLocation`); the live charge power is best read from the Wall Connector via `/api/status` or the wc-poller.
- **Run conditions (this is what makes it safe):** midday under solar surplus, car plugged in and below its limit, user watching. Then the bad outcome (amperage ignored → 48 A in the created window) is solar-powered and ~free. Write ONE schedule, read back on a 30–60 s loop for ~3 min, then **always clear the schedule** in a `finally{}` AND on SIGINT, and print manual-recovery steps (toggle the schedule off in the Rivian app) in case the process is killed. Gated behind `SPIKE_ALLOW_WRITE=yes-i-am-watching-the-car`.

## Lessons for reuse

- **Check for prior art before writing a spike.** The old `setChargeLimit` (command-based, dead) and the existing `rivian-*probe.ts` / `test-rivian-*.ts` scripts saved a redundant path and handed over exact payload shapes. Grep `scripts/` and `git log -S` first.
- **Introspection ≠ the answer for runtime-honoring questions.** Even if Rivian exposed its schema, it could not tell us whether the car obeys a nonzero amperage — the 4/30 lesson (amp `0` accepted-but-ignored) shows the field exists but may be inert. Some questions are only answerable by a supervised live write.
- **A green test can encode a bug.** `decide.test.ts` asserted the wrong surplus formula and avoided the failing input. When auditing, look at whether the test exercises the failure condition, not just whether it passes.
- **Two models beat one for lateral problems.** Fable, given the hard constraints, surfaced the EVSE-pilot-signal reframe and spotted that the local bridge already exists — both materially changed the ranking.

## Housekeeping

- `bfdc95e` (spike: single-run auth + probe) is committed **local-only, not pushed**. It's a dev script; nothing deploys from it. Push whenever convenient.
- No migration this session. The engine fixes are deployed (`dpl_9mKF…` READY on `b027346`).
