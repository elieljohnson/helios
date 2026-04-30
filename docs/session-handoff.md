# Session handoff — 2026-05-01

Short session, single thread: built v5 of Rivian `stopCharging` end-to-end as five atomic commits, all local-unpushed, all awaiting a live smoke test against the actual car. Car was unavailable today so the live test was deferred.

This file is for the next agent. Pick up where this one left off.

## Headline state

- **Production unchanged.** v4 no-op `stopCharging` still in effect. Helios still has zero working stop authority over the Rivian. Manual stop = unplug or lower charge limit at-or-below current SoC.
- **Five commits sit local on `main`, ahead of `origin/main`. Not pushed.** They will not change runtime behavior even after push until a one-time `POST /api/integrations/rivian/enroll` runs against the user's account; until then, `stopCharging` short-circuits with `command-API not enrolled` and behaves identically to v4.
- **Open P0 (continued)**: live smoke test of v5 against the car, then push.
- **Parallel thread newly unblocked**: Smartcar resolved ticket #SS100005693 on 2026-05-01. Step 1 of that plan (M2M API probe) ran the same day and confirmed the sync fix — `/v3/vehicles/{vid}` now returns 200 with R1S 2025 BEV metadata. Two findings carried forward from the probe: connection ID rotated (matches "connection expired" claim), and the dashboard-level scope set has ballooned from 4 permissions to 28 — needs narrowing in Smartcar's dashboard before user re-auth. Existing `app/src/lib/smartcar/client.ts` was built against V2 idioms and needs a V3 signals-architecture rewrite before any read or actuator call works. See [docs/smartcar-integration-handoff.md](smartcar-integration-handoff.md) for the full plan and probe results.

## What this session shipped (local only — DO NOT push without a live smoke test)

| Commit | Summary |
|---|---|
| `339d2b2` | docs: close 2026-04-30 P0 action items + crypto glossary |
| `8c988f3` | feat: post-stop verification loop in cron |
| `87d4743` | feat: rivian sendVehicleCommand wrapper + v5 stop + setChargeLimit |
| `ab36287` | feat: rivian phone-key enrollment flow + admin endpoint |
| `783d689` | feat: rivian command-API crypto primitives (keypair, ECDH, HKDF, HMAC) |

90/90 unit tests pass, `npx tsc --noEmit` clean, `npm run build` clean, new `/api/integrations/rivian/enroll` route registered.

## What v5 actually is

Rivian's API has two distinct surfaces. We've been mis-using (a) for one-shot stops; v5 moves to (b):

- **(a) `setChargingSchedules`** — recurring charging windows. The "Charge off-peak and save" feature.
- **(b) `sendVehicleCommand`** — one-shot HMAC-signed imperative commands. The right surface for stops.

The real command names (verified against `bretterer/rivian-python-client`, the canonical community implementation):

- `STOP_CHARGING` (not `CHARGE_STOP` as the postmortem originally guessed)
- `START_CHARGING`
- `CHARGING_LIMITS` with `params: { SOC_limit: 50..100 }` — used as `setChargeLimit` for the belt-and-suspenders profile-level lockout.

`sendVehicleCommand` requires HMAC signing with a key derived from `ECDH(ourPrivate, vehiclePublic)` → `HKDF-SHA256`. Implemented with Node's built-in `crypto` — no new dependencies. See `app/src/lib/rivian/crypto.ts`.

Prerequisite: a one-time phone-key enrollment that posts our public key to Rivian via `EnrollPhone`, then reads back the assigned `vasPhoneId` + `identityId` + the vehicle's public key from `getUserInfo`. All four fields persist in `oauth_tokens.meta` (no DB migration — meta is JSON). New admin-gated endpoint `POST /api/integrations/rivian/enroll` runs this flow.

`startCharging` deliberately left on the schedule API for now — that path currently works and migrating both surfaces simultaneously would stack risk on the only working actuator. Migrate it in a follow-up commit once v5 stop is proven.

## How to resume — the live smoke test

This is the gate before pushing.

### Pre-flight

- Rivian must be plugged in and actively drawing >1 kW.
- Run locally; production stays on v4 until commits are pushed.
- The first enroll call will trigger a "new device added" notification email/push from Rivian. The device shows up in the Rivian app under Account → Phone Keys as **"Helios"**. (User is fine with this.)

### Sequence

1. **`npm run dev`** in `app/`. Confirm v5 commits are present (`git log --oneline origin/main..HEAD`).
2. **Run enrollment**. ADMIN_TOKEN cookie required if set in `.env.local`; locally it's usually unset (dev escape hatch). Either:
   - From the browser at `http://localhost:3000`, log in as admin, then in DevTools console:
     ```js
     await fetch('/api/integrations/rivian/enroll', { method: 'POST' }).then(r => r.json())
     ```
   - Or via curl with the cookie copied from a logged-in session.
   - Expected response: `{ ok: true, enrolled: true, vas_phone_id: "...", identity_id: "..." }`.
3. **Verify enrollment landed in Rivian app**. New "Helios" entry in Account → Phone Keys.
4. **Test 1 — fire STOP_CHARGING alone.** One-shot script or REPL that imports `stopCharging` from `@/lib/rivian` and calls it. Do NOT bundle `setChargeLimit` in this call — clean attribution depends on knowing exactly which command stopped the car (see risk register below).
5. **Watch the Rivian app + Helios dashboard.** Within ~10 seconds the contactor should drop, `ev_w` should fall to 0, and the next cron tick should NOT log a verification-failure entry.
6. **Test 2 (separate, after Test 1 result is captured) — fire setChargeLimit(currentSoC).** Plug the car back in if needed (depending on whether Test 1's stop caused the car to disconnect or just halt). Verify the profile-level limit drops to current SoC in the Rivian app and the car remains stopped. Note: the limit will auto-revert overnight per the third Rivian autonomous behavior — that's expected, not a bug.

### What "passed" looks like

- `stopCharging()` returns `{ success: true, commandId: "..." }`.
- Within ~10s, the Rivian app shows charging stopped.
- Helios's next cron tick logs no verification failure.
- `ev_w` drops to ~0 W in `/api/status`.

### What "failed" looks like (and what to do)

- **Mutation rejected** (e.g. "Unauthorized device"): probably means BLE pairing IS required for charging commands. Don't push. Document the negative result on the postmortem under "v6 needs," and re-plan — either implement BLE pairing locally (substantial) or wrap a third-party daemon that's already paired.
- **Mutation accepted but car keeps charging**: the verification loop will catch it on the next tick. This is the same class of failure as v3, just in a different place. Don't push. Investigate before re-attempting.
- **CHARGING_LIMITS rejected**: lower-priority — STOP_CHARGING alone may be enough if the car doesn't auto-resume immediately. Note it; consider whether to ship without belt-and-suspenders.

### After a clean pass

- `git push origin main` — all five commits.
- Production still v4-equivalent until the same enrollment runs against the production DB. Do that next: log in as admin on prod, run the enroll endpoint once.
- Flip the postmortem `[~]` checkboxes to `[x]` with the live-test date.
- Open a follow-up commit that migrates `startCharging` to the command API too.

## Known unknowns / risk register

1. **BLE pairing requirement** — biggest risk. `bretterer`'s docstring says phone keys also need to be paired via BLE. Multiple community projects send cloud-only commands without it; we're betting it works for charging. Live test resolves this.
2. **`vehiclePublicKey` may not be provisioned immediately** after enrollment for first-time accounts. The enroll endpoint surfaces this with a "try again in 30s" error message rather than persisting partial state.
3. **Charge-limit auto-revert** — third Rivian autonomous behavior, documented in 2026-04-30 postmortem. `setChargeLimit` is profile-level (more durable than the session-level limit that reverted overnight on 2026-05-01), but unverified.
4. **Belt-and-suspenders test sequence — DECIDED 2026-05-01: separate, not bundled.** Test 1 fires `STOP_CHARGING` alone and observes ev_w. Only after that result is captured does Test 2 fire `setChargeLimit(currentSoC)` separately. Reason: clean attribution. If both fired together and the car stopped, you wouldn't know which command did it. Cost: one extra test step. Worth it given the v5 work is fresh and unverified — diagnostic clarity on each leg matters more right now than mirroring the eventual production parallel-fire flow (which is the *cron route's* job once both legs are independently proven).

## Open todos (priority ordered, updated)

1. **[P0] Live smoke test of v5 STOP_CHARGING + push.** See sequence above. Blocks production rollout. Gated on car being home + plugged in + charging.
2. **[P0] Smartcar V3 reintegration.** Unblocked 2026-05-01 by ticket #SS100005693 resolution. Three-stage plan in [docs/smartcar-integration-handoff.md](smartcar-integration-handoff.md): (a) read-only M2M probe to confirm sync fix [doable today, no car needed], (b) V3 signals-architecture rewrite of `app/src/lib/smartcar/client.ts` [doable without car], (c) full re-auth + live tests [needs car]. The 4/30 postmortem's "two paths is better than one for stops" lesson elevates this to P0 alongside the Rivian work — having an officially-supported actuator path is meaningful redundancy.
3. **[~] Integration strategy — DECIDED 2026-05-01: parallel-on-stops + Rivian-primary-on-reads.** See [docs/smartcar-integration-handoff.md](smartcar-integration-handoff.md) step 6 for full rationale. Implications: Smartcar V3 actuator migration is now P1; cron's `fireEvAction` needs to shift from serial-fallback to parallel-fire when stopping; both live tests need to pass independently before parallel-stop is real.
4. **[P1] After v5 proves out: migrate `startCharging` to command API.** Keep schedule path as fallback if the user wants explicit off-peak windows; that's a separate intent.
5. **[P1] Cron gate should include `vehicle` source** — phantom EV-state actuation risk for users with Tesla up + no-WC + no-Rivian. Needs a `not_configured` vs `unavailable` distinction so PW-only users don't get over-blocked.
6. **[P1] Split `vehicle` source into charger-side + car-side** — Tesla owns charger fields (`ev_w`, `ev_charging`, `ev_plugged_in`); Rivian/Smartcar own car fields (`ev_soc`, `ev_target`, `ev_range`). Current single tag conflates them.
7. **[P2] `pw_reserve` from Tesla `site_info` has nested try** — site_info-failure leaves `pw_reserve` mock-derived while `sources.powerwall` is `live`. Engine reads it for `should_act`.
8. **[P2] Wrap remaining DB-touching cron calls** (`writeSnapshot`, `secondsSinceLastAction`, stale-gate `appendAction`).
9. **[P2] Move `mockStatus()` out of production bundle** — env-gated import or test-only file.
10. **[P2] Generalize verification-loop pattern** — same skeleton for `setBackupReserve` and (after migration) `startCharging`. The pure function in `lib/verifyEvAction.ts` is shaped for one use case today; refactor when the second one lands.
11. **[P3] Add `morning_bridge_floor_pct` to Settings UI** — currently API-only (~15 min).
12. **[P3] Emergency-stop button in Helios UI** — Phase-2 lift, scope separately. Floor on incident response time today is the user remembering which app has a working stop. Wired to v5 once proven.

## Files most relevant to next session

- `app/src/lib/rivian/crypto.ts` — keypair, ECDH, HKDF, HMAC primitives. Pure; full unit-test coverage.
- `app/src/lib/rivian/client.ts` — `stopCharging` (v5), `setChargeLimit`, `sendVehicleCommand`, `enrollPhone`, `fetchEnrolledIdentity`, `isCommandEnrolled`, `readCommandMeta`, `saveCommandMeta`. Read the v1→v5 history docstring on `stopCharging` before changing anything.
- `app/src/app/api/integrations/rivian/enroll/route.ts` — admin-gated one-time enrollment endpoint.
- `app/src/lib/verifyEvAction.ts` — pure verification function + 11 tests.
- `app/src/app/api/cron/decide/route.ts` — verification loop integrated just before the EV decision branch.
- `docs/postmortems/2026-04-30-rivian-schedule-trap.md` — full incident context. The two `[~]` action items are the live-test gate.

## Things to NOT do next session

- **Don't push the five v5 commits without the live smoke test.** They'll silently work (`isCommandEnrolled()` short-circuits) but pushing unverified actuator code into production is exactly the discipline this project's postmortems keep saying we should hold.
- **Don't try `enabled: false` (v2) or `amperage: 0` (v3) again.** Both proven failure modes; the docstring on `stopCharging` preserves the history.
- **Don't auto-run enrollment as part of the connect flow.** Enrollment grants real-car command authority; it's deliberately a separate admin action.
- **Don't reorder Bash cwd assumptions.** The session shell resets cwd between calls; always `cd /Users/Eliel/Projects/Helios/app &&` before npm commands.
- **Don't trust API success as physical-state confirmation.** That's the whole point of the verification loop. (Lesson #3 from 2026-04-30 postmortem.)

## Vocabulary introduced this session (now in `engineering-primer.md` glossary)

- `HMAC` — short signature over `(message, secret)` that proves you held the secret without revealing it.
- `ECDH` — two parties combine their key pairs to derive the same shared secret without ever transmitting it.
- `HKDF` — turns a raw shared secret into a uniformly-distributed key suitable for HMAC.
- `SECP256R1 (P-256, prime256v1)` — the specific elliptic curve Rivian uses for its command-signing keys.

## Production state at session end

```
2026-05-01 (afternoon PT)
v4 no-op stopCharging still in effect (production unchanged).
v5 commits local on main, unpushed.
Live test deferred — car unavailable.
```
