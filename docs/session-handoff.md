# Session handoff — 2026-05-01

Long single-day session. Two parallel threads ran end-to-end:

1. **Rivian v5 stopCharging** — built end-to-end, awaiting live smoke test (car was away).
2. **Smartcar V3 reintegration** — unblocked mid-session by Smartcar's ticket resolution; read-side migration shipped, dashboard scope narrowed, integration strategy decided.

Twelve commits sit local on `main`, ahead of `origin/main`. None pushed. Production runtime behavior is unchanged from session start: v4 no-op `stopCharging` still in effect, Smartcar still dormant.

---

## Headline state

- **Production unchanged.** v4 no-op `stopCharging` still in effect. Helios still has zero working stop authority over the Rivian. Manual stop = unplug or lower the Rivian profile-level charge limit at-or-below current SoC.
- **12 commits local, unpushed.** They're functionally inert in production until a manual admin action triggers them (`POST /api/integrations/rivian/enroll` for Rivian v5; Smartcar Settings re-auth for V3 reads).
- **Open P0**: live smoke test of Rivian v5 against the car. Gates push.
- **Open P0**: Smartcar V3 actuator migration + reconnect. Three of four prerequisite steps are done; the fourth (V3 actuator code + live test) is what's left.

## What this session shipped (12 commits, all local)

Listed newest → oldest. None of these are in production yet.

| Commit | Type | Summary |
|---|---|---|
| `001022f` | docs | live-test sequence — separate STOP_CHARGING and setChargeLimit tests |
| `47a292b` | docs | integration strategy decided — parallel stops, Rivian-primary reads |
| `71b418d` | feat | smartcar V3 read-side migration (signals API) |
| `e4bef3f` | docs | smartcar V3 sync-fix probe passed + scope-audit action item |
| `fa79bdf` | docs | smartcar ticket #SS100005693 resolved — incorporate V3 path migration |
| `6cae99c` | docs | park v5 stopCharging at "code shipped, awaiting live test" |
| `339d2b2` | docs | close 2026-04-30 P0 action items + crypto glossary |
| `8c988f3` | feat | post-stop verification loop in cron |
| `87d4743` | feat | rivian sendVehicleCommand wrapper + v5 stop + setChargeLimit |
| `ab36287` | feat | rivian phone-key enrollment flow + admin endpoint |
| `783d689` | feat | rivian command-API crypto primitives (keypair, ECDH, HKDF, HMAC) |

**Verification at session end:** 101/101 unit tests pass, `npx tsc --noEmit` clean, `npm run build` clean, new `/api/integrations/rivian/enroll` route registered.

## Decisions locked in this session

These resolve open questions and shape future work; surfacing them up top so future-me doesn't re-litigate.

1. **Integration strategy: (c) parallel-fire on stops, (b) Rivian-primary on reads.** See `docs/smartcar-integration-handoff.md` step 6. Implication: Smartcar V3 actuator migration moves from "deferred indefinitely" to P1. Cron's `fireEvAction` will shift from serial-fallback to parallel-fire on stops. Reads stay Rivian-primary because Rivian's GraphQL is fresher and richer than Smartcar's normalized signals.
2. **Belt-and-suspenders test sequence: separate, not bundled.** Live test fires `STOP_CHARGING` alone first; only after that result is captured does a separate Test 2 fire `setChargeLimit(currentSoC)`. Reason: clean attribution. If both fire together and the car stops, you don't know which command did it.
3. **Smartcar dashboard scope narrowed.** Application-level config trimmed from 22 selected signals to 11. The four read signals our V3 client uses are checked; sensitive groups (Climate, Closure, Surveillance, Service, HVAC, Odometer) are empty. Bundled "Vehicle information" signals (ConnectivityStatus, VehicleUserAccount, VehicleIdentification.Packages/Trim) cannot be individually disabled — verified harmless metadata. Commands tab: only `Control EV Charge` enabled, no HVAC/navigation/PIN/lock/unlock/trunk. Configuration is **Published**.
4. **Rivian app residual schedule cleanup.** Confirmed harmless. The "Daily 8–8:30pm" schedule entry left over from the 4/30 incident has its toggle off; per postmortem factor 6, an inactive schedule and no schedule are functionally identical (Rivian's autonomous default takes over either way). The `STOP_CHARGING` command surface doesn't interact with schedules anyway.

## What we learned this session

These are the cross-cutting findings worth pinning beyond any single file:

1. **The Rivian command API is a substantial lift, not a drop-in for the schedule API.** The 4/30 postmortem estimated 2–4h for v5; actual was ~3.5h coding + tests, before any live debugging. The under-estimate came from missing the phone-key enrollment flow and HMAC plumbing entirely. Whenever a postmortem says "wire X via the proper API," budget for the auth/handshake layer too — a swap is rarely just a swap.
2. **Webfetch summaries of API docs cannot be trusted on schema-shape questions.** Two webfetches gave contradictory accounts of the V3 signals endpoint (per-signal vs bulk, kebab-case vs dotted-snake). Resolution required reading the official Smartcar Node SDK source on GitHub and running a live discovery probe. **Empirical > summary, always.**
3. **The right verification surface is the canonical UI, not the API response.** The 4/30 postmortem already nailed this; it bit again here. The M2M-token probe earlier in the session showed 28 permissions on the connection, which I read as a security alarm. Actually checking the dashboard's per-vehicle view showed many of those as "No permissions" — the M2M token surfaces the application's *theoretical capability*, not what's granted to a specific connection. **Read the same surface a user would.**
4. **V3 staleness pattern is real and pervasive.** Smartcar V3 returns most signals with `status: "ERROR"` but a non-null `body` containing the last cached OEM value. Treating ERROR as a hard failure means the snapshot fails almost always. Treating it as best-effort means using cached values that could be hours stale. We chose best-effort to match Helios's existing "use what's there, surface staleness via source tags" pattern, but the next session needs to thread `oemUpdatedAt` into the source-status plumbing so consumers can see how stale the data is.
5. **Bundled signal permissions exist and aren't worth fighting.** Smartcar V3 ties multiple status booleans (Is Asleep, Is Online, etc.) to a single umbrella permission like `read_vehicle_info`. They can't be individually disabled without losing the umbrella. The pragmatic move is: tighten the *control_** permissions (which DO matter), and accept the bundled `read_*` status booleans as harmless metadata.
6. **V2 and V3 sit on different hosts.** Smartcar's V3 endpoints live at `vehicle.api.smartcar.com`, V2 at `api.smartcar.com`. Setting a single `VEHICLE_API_BASE` is a footgun — caught mid-implementation only because we'd run a live probe earlier and remembered the host. New code uses path-prefix routing in `scFetch` to pick the right host per call.
7. **Pure-function transforms are the only testable layer in an integration.** The HTTP call to Smartcar V3 is unmockable without setup we don't have. The data-shape projection from V3 signals → `SmartcarEvSnapshot` IS testable, and it's the part most likely to have a bug. Splitting them (network in `client.ts`, transform in `transform.ts`) gave us 11 unit tests on the bug-prone surface and clean test boundaries on the unmockable one.
8. **"Pushing" and "deploying behavior" are different.** Twelve commits could be pushed to prod tonight without changing runtime behavior — every new code path is gated behind manual admin actions (enrollment, reconnect). Even so, we held the discipline of "don't push unverified actuator code" written into the postmortem. The win isn't just risk avoidance; it's modeling the practice consistently for future sessions.
9. **Tonight's car-behavior risk is unrelated to git.** With cable plugged in and no active Rivian schedule, the car will charge per Rivian's autonomous defaults regardless of what code we ship. Mitigation lives at the Rivian app level (lower the profile charge limit at-or-below current SoC, or schedule a real off-peak window), not at our deploy.

## The Rivian story (v5 status)

Rivian's API has two distinct surfaces. We've been mis-using (a) for one-shot stops; v5 moves to (b):

- **(a) `setChargingSchedules`** — recurring charging windows. The "Charge off-peak and save" feature.
- **(b) `sendVehicleCommand`** — one-shot HMAC-signed imperative commands. The right surface for stops.

The real command names (verified against `bretterer/rivian-python-client`):

- `STOP_CHARGING` (not `CHARGE_STOP` as the postmortem originally guessed)
- `START_CHARGING`
- `CHARGING_LIMITS` with `params: { SOC_limit: 50..100 }` — used as `setChargeLimit` for the belt-and-suspenders profile-level lockout

`sendVehicleCommand` requires HMAC signing with a key derived from `ECDH(ourPrivate, vehiclePublic)` → `HKDF-SHA256` → `HMAC-SHA256(secret, command || timestamp)`. Implemented in `app/src/lib/rivian/crypto.ts` using Node's built-in `node:crypto` — no new dependencies. 12 unit tests pin the math.

Prerequisite: a one-time phone-key enrollment that posts our public key to Rivian via `EnrollPhone`, then reads back the assigned `vasPhoneId` + `identityId` + the vehicle's public key from `getUserInfo`. All four fields persist in `oauth_tokens.meta` (no DB migration — meta is JSON). New admin-gated endpoint `POST /api/integrations/rivian/enroll` runs this flow.

`startCharging` deliberately left on the schedule API for now — that path currently works and migrating both surfaces simultaneously would stack risk on the only working actuator. Migrate it after v5 stop is proven.

**Open risk**: `bretterer`'s docstring notes phone keys "also need to be paired locally via BLE." Multiple community projects send cloud-only commands without BLE pairing for charging actions specifically — we're betting it works. If it doesn't, v5 has to be replanned (BLE pairing or wrapping a third-party paired daemon).

## The Smartcar story (newly active)

After ~3 weeks of dormancy, Smartcar's ticket resolved on 2026-05-01 with a two-part finding: (a) sync bug fixed, (b) the V2-style paths we were probing never worked on V3.

**What got done this session:**

1. M2M sync-fix probe ran. `/v3/connections` and `/v3/vehicles/{vid}` both returned 200 — sync confirmed fixed. Connection ID rotated (matches Smartcar's "the connection has since expired" claim); vehicle ID unchanged.
2. V3 signal-discovery probe ran via `app/scripts/discover-smartcar-signals.ts` (kept as committed dev tool). Captured the exact V3 signal codes for the connected R1S — 20 signals, with `tractionbattery-stateofcharge`, `tractionbattery-range`, `charge-ischarging`, `charge-ischargingcableconnected` as the four Helios needs.
3. V3 read-side migration shipped (commit `71b418d`). New `transform.ts` with 11 unit tests; `client.ts`'s `getEvSnapshot()` rewritten against the V3 signals endpoint; `listVehicleIds()` rewritten against `/v3/connections`. Actuators (`startCharging`, `stopCharging`) deliberately left V2-style with TODO V3 markers — to be migrated as part of the parallel-stop work.
4. Smartcar dashboard scope narrowed and **Published**. Scope decision: 11 selected signals (4 active, 2 future-need, 5 bundled-required), Commands tab limited to `Control EV Charge` only.

**What's left for Smartcar:**

- V3 actuator migration (move `startCharging` / `stopCharging` to V3 command shape — verify exact endpoint at `smartcar.com/docs/api-reference/commands` before writing).
- Reconnect via Settings → Integrations (the existing token is expired; full re-auth required, not refresh).
- Cron's `fireEvAction` shifts from serial-fallback to parallel-fire on stops (the integration-strategy decision's downstream code change).
- Live tests for Smartcar V3 reads (after reconnect) and Smartcar V3 stop (after actuator migration).

Full plan in `docs/smartcar-integration-handoff.md`.

## How to resume — the live smoke test (Rivian v5)

This is the gate before pushing the 4 v5 commits.

### Pre-flight

- Rivian must be plugged in and actively drawing >1 kW.
- Run locally; production stays on v4 until commits are pushed.
- The first enroll call will trigger a "new device added" notification email/push from Rivian. The device shows up in the Rivian app under Account → Phone Keys as **"Helios"**. (User has acknowledged.)

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
4. **Test 1 — fire `STOP_CHARGING` alone.** One-shot script or REPL that imports `stopCharging` from `@/lib/rivian` and calls it. Do NOT bundle `setChargeLimit` in this call — clean attribution depends on knowing exactly which command stopped the car.
5. **Watch the Rivian app + Helios dashboard.** Within ~10 seconds the contactor should drop, `ev_w` should fall to 0, and the next cron tick should NOT log a verification-failure entry.
6. **Test 2 — fire `setChargeLimit(currentSoC)` separately.** Plug back in if needed (depending on whether Test 1 caused the car to disconnect or just halt). Verify the profile-level limit drops to current SoC in the Rivian app and the car remains stopped. Note: the limit will auto-revert overnight per the third Rivian autonomous behavior — that's expected, not a bug.

### What "passed" looks like

- `stopCharging()` returns `{ success: true, commandId: "..." }`.
- Within ~10s, the Rivian app shows charging stopped.
- Helios's next cron tick logs no verification failure.
- `ev_w` drops to ~0 W in `/api/status`.

### What "failed" looks like (and what to do)

- **Mutation rejected** ("Unauthorized device" or similar): probably means BLE pairing IS required for charging commands. Don't push. Document the negative result on the postmortem under "v6 needs," and re-plan — either implement BLE pairing locally (substantial) or wrap a third-party daemon that's already paired.
- **Mutation accepted but car keeps charging**: the verification loop will catch it on the next tick. This is the same class of failure as v3, just in a different place. Don't push. Investigate before re-attempting.
- **CHARGING_LIMITS rejected**: lower-priority — STOP_CHARGING alone may be enough if the car doesn't auto-resume immediately. Note it; consider whether to ship without belt-and-suspenders.

### After a clean pass

- `git push origin main` — all 12 commits (the v5 set + the Smartcar V3 read commit + docs).
- Production still v4-equivalent until the same enrollment runs against the production DB. Do that next: log in as admin on prod, run the enroll endpoint once.
- Flip the postmortem `[~]` checkboxes to `[x]` with the live-test date.
- Open a follow-up: migrate `startCharging` to the command API; migrate Smartcar `stopCharging` / `startCharging` to V3 commands; switch cron's `fireEvAction` to parallel-fire on stops.

## Open todos (priority ordered)

1. **[P0] Live smoke test of Rivian v5** + push. See sequence above. Gated on car being home + plugged in + charging.
2. **[P0] Smartcar V3 actuator migration** (`startCharging`, `stopCharging` to V3 command shape). Required for the parallel-stop strategy decided this session. Doable without the car (read V3 commands docs, write code, test build). Live verification needs car + reconnect.
3. **[P0] Reconnect Smartcar via Settings UI.** Gates Smartcar V3 reads + actuator live tests. Sequence per Smartcar handoff: do this AFTER actuator migration lands so new tokens consume working V3 client code.
4. **[P1] Switch cron's `fireEvAction` to parallel-fire on stops.** Once both Rivian v5 STOP_CHARGING and Smartcar V3 stopCharging are independently proven, this is the cron-route change that makes parallel-stop real.
5. **[P1] After v5 proves out: migrate Rivian `startCharging` to command API.** Keep schedule path as fallback if the user wants explicit off-peak windows; that's a separate intent.
6. **[P1] Cron gate should include `vehicle` source** — phantom EV-state actuation risk for users with Tesla up + no-WC + no-Rivian. Needs a `not_configured` vs `unavailable` distinction so PW-only users don't get over-blocked.
7. **[P1] Split `vehicle` source into charger-side + car-side** — Tesla owns charger fields (`ev_w`, `ev_charging`, `ev_plugged_in`); Rivian/Smartcar own car fields (`ev_soc`, `ev_target`, `ev_range`). Current single tag conflates them.
8. **[P2] `pw_reserve` from Tesla `site_info` has nested try** — site_info-failure leaves `pw_reserve` mock-derived while `sources.powerwall` is `live`. Engine reads it for `should_act`.
9. **[P2] Wrap remaining DB-touching cron calls** (`writeSnapshot`, `secondsSinceLastAction`, stale-gate `appendAction`).
10. **[P2] Move `mockStatus()` out of production bundle** — env-gated import or test-only file. The 4/29 postmortem's structural fix; still pending.
11. **[P2] Generalize verification-loop pattern** — same skeleton for `setBackupReserve` and (after migration) `startCharging`. The pure function in `lib/verifyEvAction.ts` is shaped for one use case today; refactor when the second one lands.
12. **[P2] Thread `oemUpdatedAt` into source-status plumbing.** V3 signals carry per-signal staleness; Helios's existing source-status only tracks "live/unavailable/mock" at the provider level. Not urgent until we see a stale-data incident.
13. **[P3] Add `morning_bridge_floor_pct` to Settings UI** — currently API-only (~15 min).
14. **[P3] Emergency-stop button in Helios UI** — Phase-2 lift, scope separately. Floor on incident response time today is the user remembering which app has a working stop. Wire to the parallel-stop path once both legs are proven.
15. **[user-only, anytime]** `/ultrareview` the v5 + Smartcar V3 commits before pushing. User-billed; user-triggered. Recommended before live test if budget allows.

## Files most relevant to next session

- `app/src/lib/rivian/crypto.ts` — keypair, ECDH, HKDF, HMAC primitives. Pure; full unit-test coverage.
- `app/src/lib/rivian/client.ts` — `stopCharging` (v5), `setChargeLimit`, `sendVehicleCommand`, `enrollPhone`, `fetchEnrolledIdentity`, `isCommandEnrolled`, `readCommandMeta`, `saveCommandMeta`. Read the v1→v5 history docstring on `stopCharging` before changing anything.
- `app/src/app/api/integrations/rivian/enroll/route.ts` — admin-gated one-time enrollment endpoint.
- `app/src/lib/verifyEvAction.ts` — pure verification function + 11 tests.
- `app/src/app/api/cron/decide/route.ts` — verification loop integrated just before the EV decision branch; serial-fallback `fireEvAction` (will become parallel-fire on stops).
- `app/src/lib/smartcar/transform.ts` — V3 signals → `SmartcarEvSnapshot`. Pure; 11 tests.
- `app/src/lib/smartcar/client.ts` — V3 reads done; V2 actuators with TODO V3 markers.
- `app/scripts/discover-smartcar-signals.ts` — committed dev tool for V3 signal-list discovery.
- `docs/postmortems/2026-04-30-rivian-schedule-trap.md` — full incident context. The two `[~]` action items are the live-test gate.
- `docs/smartcar-integration-handoff.md` — full Smartcar reintegration plan, decisions captured, probe results.

## Things to NOT do next session

- **Don't push the v5 commits without the live smoke test.** They'll silently work (`isCommandEnrolled()` short-circuits) but pushing unverified actuator code into production is exactly the discipline the postmortems keep saying we should hold.
- **Don't try `enabled: false` (v2) or `amperage: 0` (v3) again** for stop. Both proven failure modes; the docstring on `stopCharging` preserves the history.
- **Don't auto-run enrollment as part of the connect flow.** Enrollment grants real-car command authority; it's deliberately a separate admin action.
- **Don't reconnect Smartcar before V3 actuators are migrated.** New tokens won't consume V2-style paths. Migration first, then reconnect.
- **Don't reorder Bash cwd assumptions.** The session shell resets cwd between calls; always `cd /Users/Eliel/Projects/Helios/app &&` before npm commands.
- **Don't trust API success as physical-state confirmation.** That's the whole point of the verification loop. (Lesson #3 from 2026-04-30 postmortem.)
- **Don't trust webfetch summaries of API docs on schema-shape questions.** Read the official SDK or run a live probe.

## Tonight's car-behavior note (separate from git)

The user is out tonight with the cable plugged in. With v4 no-op `stopCharging` in effect and no active Rivian schedule, the car will charge per Rivian's autonomous defaults — "plugged in + below limit → charge to limit at full rate" (per 4/30 postmortem factor #6). If the charge window overlaps PG&E E-TOU-C peak (16:00–21:00 PT), grid imports run $0.58/kWh.

**This is unrelated to the git decision.** Pushing or holding the 12 commits has zero impact on tonight's runtime (everything's gated behind manual admin actions). The mitigation is at the Rivian app level: lower the profile charge limit to current SoC before leaving (the at-target gate fires immediately and the car stops), or set up a real off-peak schedule (PG&E off-peak is 24:00–15:00 PT).

Captured here so a future agent reviewing this session understands the production state ≠ the git state.

## Vocabulary introduced this session (now in `engineering-primer.md` glossary)

- `HMAC` — short signature over `(message, secret)` that proves you held the secret without revealing it.
- `ECDH` — two parties combine their key pairs to derive the same shared secret without ever transmitting it.
- `HKDF` — turns a raw shared secret into a uniformly-distributed key suitable for HMAC.
- `SECP256R1 (P-256, prime256v1)` — the specific elliptic curve Rivian uses for its command-signing keys.
- `JSON:API` — a specific REST response convention where every record has `id, type, attributes, relationships, links` keys. Smartcar V3 uses this shape.
- `signals-based API` — instead of one endpoint per resource, one endpoint returns a heterogeneous list of named signals; caller picks what they want from the array.
- `stale-but-cached pattern` — when an upstream API returns its last-known value alongside a "couldn't refresh" status, rather than a hard error. Smartcar V3 does this aggressively.
- `actuator` — code that mutates physical state (a stop, a reserve write, a charge start), as distinct from a `decider` (pure function that recommends an action).
- `verification loop` — pattern where after firing an actuator, you check on a later tick whether the physical world actually reflected the intent.
- `phone-key enrollment` — Rivian's pre-shared-key flow where a "phone" (in our case Helios) registers a public key with the cloud, and from then on every command is signed with the matching private key.

## Production state at session end

```
2026-05-01 (evening PT)
v4 no-op stopCharging in effect (production unchanged from session start).
12 commits local on main, unpushed.
Rivian v5 live test deferred — car away tonight.
Smartcar V3 read migration shipped local; reconnect deferred until actuator migration.
Smartcar dashboard scope narrowed and Published.
Integration strategy decided: parallel-on-stops, Rivian-primary-on-reads.
Belt-and-suspenders test sequence decided: separate, not bundled.
Tonight: cable plugged in, no Helios stop authority, car will follow Rivian defaults.
```
