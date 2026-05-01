# Session handoff — 2026-05-01 (extended into 05-01 morning)

Two-act session. Both acts produced definitive negative results on the same underlying constraint.

**Act 1 (evening 04-30 → morning 05-01):** Rivian v5 stopCharging via the unofficial vehicle-command API. Built end-to-end; live test failed because BLE pairing is mandatory and Helios on Vercel can't pair. Closed as dead branch.

**Act 2 (morning 05-01):** Smartcar V3 — pivoted here because the postmortem said "if cloud-only Rivian fails, fall back to officially-supported Smartcar." Did the V3 read-architecture refactor (M2M token + sc-user-id header), corrected the actuator paths/bodies to V3's `/commands/charge/{start,stop,set-limit}` shape, ran the live test against the same charging Rivian. **Same fundamental failure**: `409 DEVICE_PAIRING_REQUIRED`. Same OEM-level pairing constraint, different protocol layer.

**Net finding**: cloud-only charging-command authority for the Rivian R1S is not achievable through any cloud API available to this deployment. Both "unofficial" and "officially-supported" cloud routes are gated by the same physical-pairing requirement. Helios's read-side path through Smartcar V3 works perfectly and is committed; the actuator path via either provider does not.

The session shipped a substantial amount of code that survives this finding — the V3 read architecture is correct and reusable; the V3 actuator paths/bodies are correctly reverse-engineered (the requests reach Smartcar's OEM-state-validation layer, only to be blocked there); the verification-loop pattern is provider-agnostic and ready for any future actuator integration. The work is not wasted — it's clarified.

Sixteen commits sit local on `main`. The five Rivian v5 feature commits remain dead-branch (don't push). The Smartcar V3 read-migration commits (`71b418d`, `e4bef3f`, `498164d`, `a56e76f`) are pushable any time and add a working read fallback. The Smartcar V3 actuator commits (`49ebf09`, `cae2ef9`, `2753707`) are technically correct but call paths that return `DEVICE_PAIRING_REQUIRED` — pushing them would mean the cron logs an honest "Smartcar: DEVICE_PAIRING_REQUIRED" entry on every stop attempt, which is no worse than today's "Rivian returned success: false" but adds noise. Worth deciding whether to push these later.

---

## Headline state

- **Production unchanged.** v4 no-op `stopCharging` still in effect. Helios still has zero working stop authority over the Rivian via any path. Manual stop authority remains: unplug, or lower the Rivian profile-level charge limit at-or-below current SoC via the Rivian app.
- **Smartcar V3 reads work end-to-end.** `getEvSnapshot()` via M2M + sc-user-id returns clean R1S data. SoC is stale relative to Rivian-direct (V3's documented stale-cache pattern), but the path is fully functional as a read fallback.
- **All three plausible actuator paths empirically closed**: (1) Rivian cloud command API, (2) Smartcar V3 cloud commands, (3) local BLE via bretterer/rivian-python-client. The Gen 2 R1S appears to use Apple Car Key, not legacy BLE phone-key — which means even a local BLE daemon (v6) can't pair, because Apple Car Key requires Apple's secure-enclave-bound provisioning.
- **Strategic decision DECIDED 2026-05-01: Option B — Helios as a decision engine with manual-action UX.** Helios computes when charging should stop and surfaces it clearly to the user via the activity feed + (eventually) push notification; execution moves to the user. v6 is closed indefinitely. The case-study reframe lands as: *"built a sophisticated home-energy decision engine, hit a hardware-level OEM pairing requirement that no cloud-or-local architecture can bypass for this vehicle, shipped read-only with clear manual-action prompts and documented the finding honestly."* Stronger engineering narrative than "everything works."

## What this session shipped (16 commits, all local)

Listed newest → oldest. Grouped by survival status post live-test.

**Smartcar V3 read path — works, ship-ready:**

| Commit | Type | Summary |
|---|---|---|
| `a56e76f` | fix | smartcar listVehicleIds filters to live-mode connections only |
| `498164d` | refactor | smartcar V3 architecture — M2M token + sc-user-id auth |
| `e4bef3f` | docs | smartcar V3 sync-fix probe passed + scope-audit action item |
| `71b418d` | feat | smartcar V3 read-side migration (signals API) |

**Smartcar V3 actuator path — code is correct, OEM-blocked by DEVICE_PAIRING_REQUIRED:**

| Commit | Type | Summary |
|---|---|---|
| `cae2ef9` | fix | smartcar V3 actuator paths/bodies (`/commands/charge/{start,stop,set-limit}`) |
| `2753707` | feat | cron fireEvAction — Smartcar-only stops, Rivian-primary starts |
| `49ebf09` | feat | smartcar V3 actuator migration (initial — superseded by `cae2ef9`) |
| `c2e548e` | feat | re-enable smartcar row in Settings → Integrations |
| `b3cfb37` | fix | smartcar V3 OAuth code-exchange uses iam.smartcar.com (later superseded by `498164d`'s M2M refactor) |

**Rivian v5 — dead branch, do NOT push:**

| Commit | Type | Summary |
|---|---|---|
| `8c988f3` | feat | post-stop verification loop in cron *(provider-agnostic; salvageable)* |
| `87d4743` | feat | rivian sendVehicleCommand wrapper + v5 stop + setChargeLimit |
| `ab36287` | feat | rivian phone-key enrollment flow + admin endpoint |
| `783d689` | feat | rivian command-API crypto primitives (keypair, ECDH, HKDF, HMAC) |

**Docs — ship anytime:**

| Commit | Type | Summary |
|---|---|---|
| `001022f` | docs | live-test sequence — separate STOP_CHARGING and setChargeLimit tests |
| `47a292b` | docs | integration strategy decided — parallel stops, Rivian-primary reads (now obsolete; needs follow-up update reflecting actuator failure) |
| `fa79bdf` | docs | smartcar ticket #SS100005693 resolved — incorporate V3 path migration |
| `6cae99c` | docs | park v5 stopCharging at "code shipped, awaiting live test" |
| `339d2b2` | docs | close 2026-04-30 P0 action items + crypto glossary |

**Verification at session end:** 106/106 unit tests pass, `npx tsc --noEmit` clean, `npm run build` clean.

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

## What act 2 confirmed (morning 2026-05-01, after the Smartcar live test)

14. **The OEM constraint is real, not an unofficial-API artifact.** Last night I framed the BLE-pairing finding as a Rivian-unofficial-API limitation that an officially-supported provider (Smartcar) might bypass. Wrong framing. Smartcar V3's `409 DEVICE_PAIRING_REQUIRED` proves the constraint lives at the OEM (Rivian's vehicle firmware), not at any specific cloud API surface. **Both** "unofficial" and "officially-supported" cloud paths hit it. The implication: whatever provider issues the command must hold a pairing handshake the car's firmware recognizes — and that handshake is bound to a physical device, not a cloud account.
15. **`409 DEVICE_PAIRING_REQUIRED` is the standardized OEM-pairing error to watch for.** Smartcar surfaces it in a clean structured form (status, code, suggestedUserMessage, resolution: REAUTHENTICATE). Rivian surfaces the same condition as `responseCode: 1047` on `state: 4`. Different protocols, equivalent semantics. If a future EV provider returns either of these, the answer is "you need a paired phone proxy" (i.e. v6-style architecture), not "fix the API call."
16. **Re-auth doesn't change the OEM pairing.** Smartcar's error suggests `resolution: "REAUTHENTICATE"` as the user-facing resolution, but re-running OAuth Connect doesn't add a phone pairing — it just refreshes the cloud-side connection record. We confirmed this empirically: the user reconnected successfully (Smartcar row went green for reads), and the actuator still hit DEVICE_PAIRING_REQUIRED. The "resolution" string is misleading; treat it as informational only.
17. **API-shape validation and OEM-state validation are different layers.** Smartcar's V3 actuator path went through several wrong-shape errors (`404 INVALID_PATH` on the V2-derived `/charge` path, `404` again on guessed `/commands/charge/limit`) before we found the right shape (`/commands/charge/set-limit` with the JSON:API envelope). Once the shape was right, the request reached OEM-state validation and returned `409 DEVICE_PAIRING_REQUIRED`. The shape work IS still valuable — it means we can probe state and shape independently, and the corrected paths/bodies are committed for the day v6 (or a different car) makes them callable.

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

## The Smartcar story (worked through end-to-end this session)

After ~3 weeks of dormancy, Smartcar's ticket resolved on 2026-05-01 with a two-part finding: (a) sync bug fixed, (b) the V2-style paths we were probing never worked on V3. We then went deep on V3 — and ended up rewriting the auth model entirely.

**What got done (chronological):**

1. **M2M sync-fix probe** — `/v3/connections` and `/v3/vehicles/{vid}` both returned 200, sync confirmed fixed. Connection ID rotated; vehicle ID unchanged.
2. **V3 signal-discovery probe** via `app/scripts/discover-smartcar-signals.ts` — captured the 20 signals the R1S exposes and the four Helios needs.
3. **V3 read-side migration** (`71b418d`) — `transform.ts` with 11 unit tests; `getEvSnapshot()` rewritten against V3 signals; `listVehicleIds()` against `/v3/connections`. Actuators left V2-style with TODO markers.
4. **Smartcar dashboard scope narrowed and Published** — 11 selected signals, Commands tab restricted to `Control EV Charge` only.
5. **V3 actuator migration shipped** (`49ebf09`) — using V2 SDK's `/v3/vehicles/{id}/charge` path with `{action: "STOP"}` body. Wrong: those are V2 paths. Fix landed in `cae2ef9` against the actual V3 paths under `/commands/charge/{start,stop,set-limit}`.
6. **Auth-architecture refactor** (`498164d`) — discovered mid-session that V3 doesn't issue per-user OAuth tokens at all. The whole flow is M2M token + `sc-user-id` header. Rewrote `scFetch`, dropped `exchangeCode`/`refreshTokens` to dead-code status, simplified the callback to just persist `user_id`. This was the unlock for the read path.
7. **Live-mode connection filter** (`a56e76f`) — the user's Smartcar account had a leftover SIMULATED vehicle in addition to the real R1S. Without filtering, `listVehicleIds()` pinned the simulated one. Filter on `attributes.vehicle.mode === "live"`.
8. **Smartcar reconnected via Settings UI** — fresh tokens persisted, Smartcar row went green for reads, R1S info populated.
9. **Live test of V3 actuators** — car drawing 11.2 kW, fired `stopCharging()` and `setChargeLimit()` in sequence. Both returned `409 DEVICE_PAIRING_REQUIRED` with the same error structure. Smoking gun: the OEM-level pairing constraint that blocked Rivian's command API last night blocks Smartcar V3 too.

**Surviving artifacts (all useful, all committed):**

- V3 read path is fully functional; can serve as a fallback for Rivian-direct reads
- V3 actuator paths/bodies/types are correctly reverse-engineered (request reaches OEM-state validation; the only thing blocking is OEM-level pairing)
- `projectActionResponse` helper unifies result shape across all command classes
- Live-mode filter prevents future "wrong vehicle pinned" bugs
- Test harness scripts (`test-smartcar-stop.ts`, `test-smartcar-set-limit.ts`) committed as templates

**What does NOT work (and won't, on this hardware combo, via any cloud API):**

- Stop charging
- Start charging
- Set charge limit
- Any other command-class actuator

Full plan in `docs/smartcar-integration-handoff.md`. Step 6 of that doc still reflects the obsolete "parallel-fire on stops" strategy from yesterday afternoon — needs a follow-up update reflecting the morning's findings.

## How to resume — Option B implementation (decision engine + manual-action UX)

Strategic decision is locked: **Option B**. v6 is empirically closed by the Apple Car Key finding from the BLE spike. The next session implements Helios as a decision engine that surfaces clear "I want to stop now" signals to the user, who then executes manually via the Rivian app.

### The shape of Option B

The decision engine is unchanged — it still computes, every 5 min, whether the car *should* be stopped/started/limited. What changes is the actuator path: instead of trying to execute, Helios surfaces the recommendation to the user via:

1. **Activity feed entry** — clear, scannable: *"Stop charging now (peak rate, no surplus). Open Rivian app → lower charge limit to current SoC."*
2. **Dashboard banner** — when the engine wants to stop and the car is still drawing, show a prominent "Helios recommends stop — tap for instructions" affordance.
3. **(Future) Push notification** — phone-side alert when the engine fires a high-priority recommendation. Phase 2; out of scope for the initial Option B ship.

The Rivian-app-side UX for manually stopping is already known: open Rivian app → Charging → lower the charge limit at-or-below current SoC. The car's at-target gate fires immediately. We've verified this empirically multiple times.

### Concrete implementation sketch (~1–2 days)

1. **Cron's `fireEvAction` becomes `recommendEvAction`.** Stop trying to actuate; just log the recommendation as a `charge` action with `ok: true` and a clear instruction in the `reason` field. Skip Rivian's no-op stopCharging entirely; skip Smartcar's V3 stop (it'd just hit DEVICE_PAIRING_REQUIRED). The post-stop verification loop in `lib/verifyEvAction.ts` becomes irrelevant — there's no actuation to verify. Either remove it or repurpose it for "did the user actually stop after the recommendation?"
2. **Activity-feed UI tweak.** Add visual treatment for "recommendation" actions distinct from "executed" actions. Maybe a different icon, or a "manual action" tag. The reason text needs to be action-oriented: *"Stop EV charging now — open Rivian app → Charging → set limit to {currentSoC}%"* instead of the engineering-flavored "stop ack'd...".
3. **Dashboard banner for active recommendation.** Visible on Home page when (a) engine wants to stop AND (b) `ev_w > 100W`. Banner copy + a single "Open Rivian app" button (which deep-links to `rivian://` or just shows instructions).
4. **Settings-level explanation.** Add a short callout to Settings → Integrations → Rivian explaining *why* Helios is recommend-only: "The Rivian R1S Gen 2 uses Apple Car Key for command authority, which can't be initiated from a cloud automation. Helios provides decisions; you provide the tap." Linked-out version in case study.
5. **(Optional) Push notifications.** Web Push or Apple Push via a service like Pushover. Out of scope for initial ship.

### What does NOT need a strategic decision

Mechanical cleanup tasks now that v6 is closed:

- **Push all the Smartcar V3 read commits** (`71b418d`, `e4bef3f`, `498164d`, `a56e76f`). They give Helios a working read fallback. Zero downside.
- **Push the docs commits** that capture today's findings.
- **Decide what to do with the Smartcar V3 actuator commits** (`49ebf09`, `cae2ef9`, `2753707`, `c2e548e`, `b3cfb37`). They make API calls that always fail with `DEVICE_PAIRING_REQUIRED`. Recommendation: **revert** as part of Option B — they have no path to working anymore, and removing them keeps the cron path cleaner. The V3 type definitions and `projectActionResponse` helper can stay; just remove the call sites.
- **Decide what to do with the Rivian v5 commits** (`8c988f3`, `87d4743`, `ab36287`, `783d689`). Same logic — recommendation: **revert**. v6 won't happen for this car; keeping the v5 work as dead-branch local indefinitely is just cognitive overhead. The crypto helpers and verification-loop pure function are reusable conceptually if a future Helios deployment supports a different vehicle, but they're not load-bearing for Option B.
- **Disenroll the cloud-side Rivian Helios phone-key.** The Rivian-app entry was removed manually post-spike. The cloud-side `command_*` fields in `oauth_tokens.meta` are dormant. Run `disenrollPhone` mutation to fully clean up if desired; not blocking.

### Test scripts already in place (mostly historical now)

- `app/scripts/test-rivian-stop.ts`, `test-rivian-watch.ts`, `test-rivian-set-limit.ts`, `test-rivian-cmd-state.ts` — Rivian command-API harness. Useful as templates if a future EV with a working command API is added.
- `app/scripts/test-smartcar-stop.ts`, `test-smartcar-set-limit.ts` — Smartcar V3 actuator harness. Same — template-only now.
- `app/scripts/discover-smartcar-signals.ts` — V3 signal discovery, still useful for read-side maintenance.
- `app/scripts/fix-smartcar-pinned-vehicle.ts` — live-mode vehicle re-pinner.
- `app/scripts/v6-spike/{dump-creds.ts, spike.py, scan-all.py}` — v6 feasibility spike. Committed as evidence + reference for the negative-result narrative in the case study.

All committed.

## Open todos (priority ordered, post-2026-05-01 negative result on Smartcar actuators)

1. **[✓ DECIDED 2026-05-01] Strategic direction: Option B.** v6 closed empirically by the BLE-spike Apple-Car-Key finding. Helios pivots to decision-engine-with-manual-action-UX.
2. **[P0] Implement Option B.** See "How to resume" above for the concrete sketch. Cron's `fireEvAction` becomes `recommendEvAction`; activity-feed copy gets action-oriented; dashboard adds a recommendation banner. ~1–2 days.
3. **[P0] Revert the Rivian v5 commits and the Smartcar V3 actuator commits.** v5 is dead-branch (Apple Car Key gate); Smartcar V3 actuators always return DEVICE_PAIRING_REQUIRED. Cleaner main branch + cron path. The crypto helpers, verification-loop, and V3 type definitions can stay (they have conceptual reusability); just remove the call sites and the `sendVehicleCommand` wrapper.
4. **[P0 — DOC FOLLOWUP] Update `smartcar-integration-handoff.md` step 6** to reflect Option B as the locked decision. The "parallel-stop" framing is fully obsolete now.
5. **[P1] Push everything that survives.** Smartcar V3 read-side commits + the docs commits. Helios production gets a working read fallback; v4 stopCharging behavior remains (no-op + recommendation log).
6. **[P1] Cron gate should include `vehicle` source** — phantom EV-state actuation risk for users with Tesla up + no-WC + no-Rivian. Needs a `not_configured` vs `unavailable` distinction so PW-only users don't get over-blocked.
7. **[P1] Split `vehicle` source into charger-side + car-side** — Tesla owns charger fields (`ev_w`, `ev_charging`, `ev_plugged_in`); Rivian/Smartcar own car fields (`ev_soc`, `ev_target`, `ev_range`). Current single tag conflates them.
8. **[~] Optional: clean up the dormant `command_*` fields in `oauth_tokens.meta`.** Run `disenrollPhone` mutation against Rivian + clear the meta fields. The Rivian-app phone-key entry is already removed (post-spike). Currently dormant and harmless; not blocking.
9. **[P2] `pw_reserve` from Tesla `site_info` has nested try** — site_info-failure leaves `pw_reserve` mock-derived while `sources.powerwall` is `live`. Engine reads it for `should_act`.
10. **[P2] Wrap remaining DB-touching cron calls** (`writeSnapshot`, `secondsSinceLastAction`, stale-gate `appendAction`).
11. **[P2] Move `mockStatus()` out of production bundle** — env-gated import or test-only file. The 4/29 postmortem's structural fix; still pending.
12. **[P2] Thread `oemUpdatedAt` into source-status plumbing.** V3 signals carry per-signal staleness; Helios's existing source-status only tracks "live/unavailable/mock" at the provider level. Not urgent until we see a stale-data incident.
13. **[P3] Add `morning_bridge_floor_pct` to Settings UI** — currently API-only (~15 min).
14. **[P3] (Future) Push notifications for high-priority recommendations.** Phase 2 of Option B — adds phone-side alerts when the engine wants to stop and the user isn't watching the dashboard. Out of scope for the initial Option B ship.
15. **[user-only, anytime]** `/ultrareview` the local commits before pushing. User-billed; user-triggered.

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
2026-05-01 (late morning PT, after Smartcar V3 actuator live test)

Production code: unchanged from session start (v4 no-op stopCharging).
Manual stop authority: still required (lower Rivian profile-charge-limit
  in Rivian app, or unplug). The user manually stopped charging mid-session
  after the Smartcar V3 actuator test failed.

Local commits: 16 ahead of origin/main, organized by survival status.
  - Rivian v5 (4 commits): dead-branch, hold-local, do NOT push.
  - Smartcar V3 reads (4 commits): work end-to-end, push anytime, give us
    a useful read fallback for the day Rivian-direct rate-limits.
  - Smartcar V3 actuators (5 commits): paths/bodies/types correct, all
    blocked by 409 DEVICE_PAIRING_REQUIRED at the OEM layer. Push or
    hold is a judgment call (cleaner activity log vs. complete commit
    series on origin).
  - Docs (5 commits): ship anytime; today's session-handoff overhaul
    is the most recent.

Smartcar account state: reconnected this morning; row green for reads.
  The narrowed dashboard scope (4 control + 4 read permissions) is in
  effect on the new tokens.

Rivian account state: enrolled phone key from last night's v5 test still
  present in the Rivian app under Account → Phone Keys ("Helios"). Dormant
  under v4; reusable if v6 ever happens. Optional cleanup via disenrollPhone
  mutation, not blocking.

Confirmed-impossible: cloud-only charging-command authority for the
  Rivian R1S, via either the unofficial Rivian command API or the
  officially-supported Smartcar V3 commands API. Both gated by an
  OEM-level pairing requirement that requires a physical device.

Strategic decision required next session: A (v6 local BLE daemon),
  B (read-only with manual-action UX), or C (hybrid — ship B now,
  queue v6). See "How to resume" for the analysis.
```
