# Session handoff — 2026-05-01

Long single-day session. Three threads:

1. **Rivian v5 stopCharging** — built end-to-end, **live test FAILED 22:42 PT** when the user got back. BLE pairing turned out to be mandatory; cloud-only HMAC auth is necessary but not sufficient. v5 is closed as a dead branch for our deployment shape (Vercel can't BLE-pair). Strategic implication: Smartcar V3 actuators are now the only viable path to working stop authority.
2. **Smartcar V3 reintegration** — unblocked mid-session by Smartcar's ticket resolution; read-side migration shipped, dashboard scope narrowed, integration strategy decided. **Promoted to P0** by the Rivian failure.
3. **Live test of Rivian v5** — ran end-to-end, produced a definitive negative result via `getVehicleCommand` state-machine query (`state: 4, responseCode: 1047`). Diagnostic discipline paid off: 60-second smoking gun instead of weeks of speculation.

Twelve commits sit local on `main`, ahead of `origin/main`. **None will be pushed** — the five v5 Rivian feature commits are dead-branch code that would pollute production with failing STOP_CHARGING attempts every 5 min if pushed. The remaining seven (Smartcar V3 read migration + docs) could push cleanly but the working agreement is to push docs alongside working code, so they hold too. Production runtime behavior is unchanged from session start: v4 no-op `stopCharging` still in effect, Smartcar still dormant.

---

## Headline state

- **Production unchanged.** v4 no-op `stopCharging` still in effect. Helios still has zero working stop authority over the Rivian. Manual stop = unplug or lower the Rivian profile-level charge limit at-or-below current SoC.
- **12 commits local, unpushed; the 5 v5 Rivian commits are now confirmed dead-branch.** Pushing them would activate v5 in production (enrollment data was written to the production Neon DB tonight via the dev server, so `isCommandEnrolled()` would return true), and v5 would fire STOP_CHARGING attempts every 5 min when the engine wants to stop, each one failing identically. Don't push.
- **One survivable piece from the v5 work**: the post-stop verification loop in `lib/verifyEvAction.ts` (commit `8c988f3`). That's a pure function with 11 unit tests, independently valuable for the Smartcar V3 actuator path. When that work happens, the verification loop already integrates in cron's path right where we left it.
- **Open P0** (was P1, promoted): Smartcar V3 actuator migration. Now the only path to working stop authority. Doable without the car.
- **Open P0**: Smartcar reconnect via Settings UI (after actuator migration ships).

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

## What we learned tonight (added after the live test)

10. **Cloud-side auth is necessary but not sufficient for Rivian commands.** `EnrollPhone` gives a phone-key cloud trust ("you can pair if you want"); BLE pairing is what grants command authority. The car checks for a BLE-pair handshake before honoring HMAC-signed commands, regardless of HMAC validity. Cloud `success: true` means "we received a valid signature," not "the car will execute it." We learned this empirically in 60 seconds by querying `getVehicleCommand(commandId)` after the v5 stop returned success but `ev_w` didn't drop — terminal `state: 4, responseCode: 1047` was the smoking gun.
11. **The right diagnostic is always to ask the cloud what state the request ended in.** When an actuator's API ack disagrees with physical state, query the API for command-state directly (Rivian: `getVehicleCommand`; Smartcar: their equivalent). Don't speculate from staleness or polling. The discipline of "ask, don't guess" turned a multi-hour mystery into a one-minute answer.
12. **Control tests are essential for ambiguous failures.** When the Rivian app's STOP_CHARGING worked instantly while ours didn't, that was the smoking gun for "phone-key trust tier mismatch." Without that side-by-side comparison the root cause might've been "Rivian's API is broken" instead of "our key isn't BLE-paired." When you can run the same logical operation through a known-working channel, do it.
13. **Build the discipline tools before the discipline matters.** The verification loop in `lib/verifyEvAction.ts` was specifically designed for "API success ≠ physical state" cases per the 4/30 postmortem. It worked exactly as intended tonight — would have caught the failure on the next cron tick if we hadn't already polled manually. The loop survives the v5-Rivian dead-branch and is the salvageable asset of the v5 work; it's already integrated and ready to consume Smartcar's commands when those land.

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

## The Rivian v5 story (closed as dead branch 2026-05-01)

We built v5 end-to-end this session: crypto helpers, phone-key enrollment, sendVehicleCommand wrapper, post-stop verification loop. Live test ran 22:42 PT against the actual car, drawing 11.4 kW. Result:

- `stopCharging()` returned `{ success: true, commandId: "04-80f48709e030221ac657" }` — cloud accepted, HMAC verified.
- `getVehicleCommand(commandId)` returned `{ state: 4, responseCode: 1047 }` — terminal failure on the car-onboard side.
- `ev_w` stayed at ~11.4 kW for 6 minutes of polling; SoC ticked 73→75% as the car continued charging normally.
- Control test: user's BLE-paired iPhone stopped the car instantly via the Rivian app's STOP_CHARGING flow — same command, different phone-key tier.

**The blocker:** BLE pairing is required after `EnrollPhone`. Per https://rivian-api.kaedenb.org/ble/enroll/: *"the phone is authorized to pair with the Rivian Phone Key peripheral. [After pairing,] the phone will then be able to send commands to the vehicle."* Cloud-side enrollment is necessary but not sufficient — the car's onboard logic checks for a BLE-pair handshake before honoring HMAC-signed commands.

**Why this kills v5 as designed**: Helios runs on Vercel. No Bluetooth radio. Remote BLE-pairing is not a thing the Rivian API supports — pairing requires physical proximity to the car. There is no remote workaround.

**What's reusable, what's dead:**

| Component | Status | Why |
|---|---|---|
| `lib/rivian/crypto.ts` (keypair, ECDH, HKDF, HMAC) | reusable | Algorithm is correct; would be reused by a v6 local-BLE-daemon if pursued. |
| `lib/rivian/client.ts` enrollment helpers + sendVehicleCommand wrapper | reusable | Same — the API mechanics work, just not from our deployment. |
| `lib/rivian/client.ts` v5 stopCharging / setChargeLimit body | dead | Won't physically work without BLE. Will fire failed commands if pushed. |
| `app/api/integrations/rivian/enroll` endpoint | dormant | Already ran once (data persists in production DB). Unnecessary unless v6 happens. |
| `lib/verifyEvAction.ts` (post-stop verification) | **highly reusable** | Pure function, 11 tests, generalizable to Smartcar's actuator path. This is the salvage. |

**Cleanup status:** the live-test enrollment wrote `command_*` fields to the production Neon `oauth_tokens.meta` row, and added a "Helios" entry to the user's Rivian app under Account → Phone Keys. Both are dormant in v4 production. We didn't run `disenrollPhone` to clean up — the data is harmless, the keypair could be reused for a v6 path, and removing the entry from Account → Phone Keys requires the user to do it from their Rivian app if they want it gone (we don't have a `disenrollPhone` wrapper wired). Optional housekeeping, not blocking anything.

**v6 needs (deferred indefinitely; pursue only if Smartcar V3 actuators also fail):**

A small always-on daemon on the user's home network (Pi, NUC, or spare Mac), BLE-paired with the car at first run, exposing an HTTP endpoint Helios cron can POST to. Daemon signs commands using the BLE-paired keypair and forwards via Bluetooth. This is materially new architecture — separate from Helios's Next.js + Vercel shape — and is only worth building if Smartcar V3 commands turn out to also be unreachable.

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

## How to resume — Smartcar V3 actuator migration (the new P0)

The Rivian v5 path is closed. Smartcar V3 commands are the only remaining route to working stop authority for our deployment shape. Plan in `docs/smartcar-integration-handoff.md`; condensed sequence below.

### Pre-flight (no car needed for steps 1–3)

- Need to know V3's exact command shape. The V3 read-side migration we shipped used signals; commands are a separate surface. Read `smartcar.com/docs/api-reference/commands` (or whatever the canonical V3 commands path is) before writing code.
- Smartcar's existing OAuth tokens are expired — full re-auth required after migration ships.
- The dashboard scope and Commands tab were already narrowed and **Published** this session; the Commands surface has only `Control EV Charge` enabled.

### Sequence

1. **Read V3 commands spec.** Find: exact endpoint URL, HTTP method, request body shape for `start_charge` / `stop_charge` / `set_charge_limit` (or whatever V3 calls them). Same shape of question as the V3 signals discovery — webfetch summaries lie, read the official Node SDK source on GitHub if anything is unclear.
2. **Migrate `app/src/lib/smartcar/client.ts`'s actuator functions** to V3 paths. Keep the existing function signatures — `startCharging`, `stopCharging` — so consumers in `cron/decide/route.ts` don't change. Add a `setChargeLimit(socPct)` for parity with the parallel-stop strategy.
3. **Run a build + tests locally** to catch type/path issues before live test.
4. **Reconnect Smartcar via Settings UI** — the existing token is expired, full re-auth needed (per the 2026-05-01 ticket resolution). The narrowed dashboard scope means the new tokens won't carry the over-broad permission set.
5. **Live test** — needs the car plugged in and actively charging. Same shape as the Rivian live test that failed: fire `stopCharging()` alone, watch `ev_w` for ~30s, then a separate `setChargeLimit(currentSoC)` test. Use the verification loop's logic (it's already integrated in `cron/decide/route.ts`) to confirm physical state matches API ack.

### What "passed" looks like

- `stopCharging()` returns success.
- Within ~10s, `ev_w` drops to ~0 W in `/api/status`.
- Helios's next cron tick logs no verification-failure entry.

### What "failed" looks like (and what to do)

- **Smartcar V3 stop also fails** (cloud accepts, car ignores or rejects): this is the worst case. We'd then have zero working stop authority via either provider. **At that point**, evaluate v6 (local BLE daemon for Rivian) seriously, or accept that Helios's stop authority is fundamentally unsolvable from a cloud-only deployment for this hardware combination and pivot to alerting + manual-stop UX.
- **Smartcar's stop is durable but flaky** (works 80% of the time): lower bar than ideal. Ship it, monitor, decide later if v6 is worth the lift.
- **Smartcar's stop works cleanly**: ship it, switch cron's `fireEvAction` from serial-fallback to "Smartcar primary, no Rivian command fallback," update the integration-strategy decision in `docs/smartcar-integration-handoff.md` to reflect single-path-via-Smartcar (the parallel-stop strategy was contingent on Rivian's cloud command path working, which it doesn't).

### Test scripts already in place from this session

- `app/scripts/test-rivian-stop.ts` — fired `stopCharging` once. Failed on Rivian; useful template for the Smartcar equivalent.
- `app/scripts/test-rivian-watch.ts` — polls `/api/status` every 3s. Provider-agnostic; reuse as-is.
- `app/scripts/test-rivian-set-limit.ts` — fires `setChargeLimit`. Same template applies for Smartcar.
- `app/scripts/test-rivian-cmd-state.ts` — Rivian-specific diagnostic. Smartcar's command status path will be different; write a parallel script when the V3 commands shape is known.

### After a clean pass

- Push the relevant Smartcar commits (no v5 Rivian commits — those stay local indefinitely or get reverted).
- Update the integration strategy decision (see `docs/smartcar-integration-handoff.md` step 6) to reflect single-path-via-Smartcar.
- Cron's `fireEvAction` becomes "Smartcar only" for stops. Schedule path stays as a separate intent for legitimate off-peak windows the user wants to set manually.

## Open todos (priority ordered, post-live-test pivot)

1. **[P0] Smartcar V3 actuator migration** (`startCharging`, `stopCharging`, plus a new `setChargeLimit` for parity). Now the only path to working stop authority. Doable without the car: read V3 commands spec, write code, build, test. Live verification needs car + reconnect.
2. **[P0] Reconnect Smartcar via Settings UI** — only after actuator migration ships, so new tokens consume working V3 client code.
3. **[P0] Live test Smartcar V3 stop.** Same shape as the Rivian v5 test that failed tonight. If this also fails, evaluate v6 (local BLE daemon) seriously; otherwise ship Smartcar as single-path stop authority.
4. **[~] Decide whether to revert the v5 Rivian feature commits or hold them indefinitely local.** Holding has zero cost; reverting frees a cleaner main branch but loses the working crypto + enrollment helpers if v6 ever happens. Recommendation: hold local until either (a) v6 path is decided, or (b) Smartcar ships and we do branch hygiene cleanup.
5. **[~] Optional: clean up the "Helios" entry in user's Rivian app phone keys.** Run `disenrollPhone` mutation if we want to remove it. Currently dormant and harmless; not blocking.
6. **[P1] Cron's `fireEvAction`: switch from serial-fallback to Smartcar-only when stopping** (was "parallel-fire" — the Rivian leg is gone, so it collapses to single-path). Schedule path stays available for user-set off-peak windows; that's a separate intent.
7. **[~] Update integration strategy decision in `smartcar-integration-handoff.md` step 6** to reflect single-path-via-Smartcar (the parallel-stop strategy was contingent on Rivian's cloud command path working, which it doesn't for our deployment).
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
2026-05-01 (late evening PT, after live test)
v4 no-op stopCharging in effect (production unchanged from session start).
12 commits local on main; the 5 v5 Rivian feature commits are confirmed dead-branch
  and will not be pushed. Hold or revert TBD.
Rivian v5 live test FAILED — BLE pairing required, not viable from Vercel.
Production DB has dormant Rivian phone-key enrollment data + a "Helios" entry
  in user's Rivian app phone-keys list. Both harmless under v4; would be
  reusable if a v6 local-BLE-daemon path is ever pursued.
Smartcar V3 read migration shipped local; reconnect deferred until V3 actuator
  migration lands.
Smartcar dashboard scope narrowed and Published.
Integration strategy DECIDED earlier today: parallel-on-stops + Rivian-primary
  reads. The parallel-on-stops decision is contingent on Rivian's command path
  working, which it doesn't for our deployment — needs revising to "Smartcar
  single-path stops" as part of the next session's actuator migration.
Car charged ~16.5 kWh today (100% solar, $0 grid imports); user manually
  stopped charging tonight at 22:52 PT after the live test confirmed Helios
  v5 couldn't.
```
