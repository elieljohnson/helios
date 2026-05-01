# Option B implementation — read-only Helios with Web Push recommendations

**Date:** 2026-05-01 (afternoon, picking up after the morning's Apple Car Key finding)
**Severity:** strategic pivot, not an incident — but the pivot is substantial enough to warrant the same post-mortem rigor
**Author:** Eliel Johnson (with Claude as co-builder)
**Status:** Shipped to `main`, deployed, end-to-end Web Push verified on iPhone PWA.

---

## Summary

Two days of empirical investigation closed every cloud-and-local path to charging-command authority on the user's 2025 Rivian R1S Gen 2:

1. **Rivian unofficial command API** (cloud) → `state:4 / responseCode:1047` (paired-key required at OEM).
2. **Smartcar V3 commands** (cloud, officially supported) → `409 DEVICE_PAIRING_REQUIRED` (same OEM constraint, different protocol).
3. **Local BLE via `bretterer/rivian-python-client`** → no Rivian peripheral broadcasts at all. Inference: Gen 2 R1S uses Apple Car Key (Apple-Wallet-and-secure-enclave-bound), which cannot be initiated from any non-Apple-enclave device. Detail: `memory/project_apple_car_key_block.md`.

With every actuator path closed for this specific vehicle, Helios pivoted to **Option B: a decision engine that surfaces stop/start as recommendations, with the user as the actuator** (manually, via the Rivian app — the only path that holds the paired credential).

This session implemented Option B end-to-end across 11 atomic commits + 4 small follow-on improvements. Web Push round-trip verified on the iPhone PWA: server → push service → device → SW → notification → tap → Rivian app via `rivian://` deep link. Build green, 89/89 unit tests pass throughout.

## What shipped

Listed in commit order, oldest → newest. Reverts first, then the build, then polish.

**Reverts — gut the dead actuator paths:**

| Commit | Type | Summary |
|---|---|---|
| `7ecb23d` | revert | Remove Rivian v5 command-API surface (Apple Car Key blocks it). 742 lines deleted: crypto.ts + tests, enroll route, sendVehicleCommand wrapper, all v5 mutations and types. v4 no-op `stopCharging` restored. |
| `f94ab57` | revert | Gut Smartcar V3 actuators. Stub no-op shells preserved temporarily so the cron's `fireEvAction` call sites still compiled — removed in R3. |
| `b50b658` | refactor | Drop the EV actuator chain in `cron/decide/route.ts`. `fireEvAction`/`fireStart`/`fireStop`, post-stop verification block, `verifyEvAction.ts` + 11 tests, `setChargingSchedule`/`startCharging` in rivian/client.ts, `SmartcarActuatorResult` type — all removed. The EV branch becomes compute-and-return only. **786 lines deleted**, 14 added. |

**Build — recommendation engine and Web Push:**

| Commit | Type | Summary |
|---|---|---|
| `3b255ef` | feat | Pure `recommendEvAction(decision, snapshot)` translator. Returns `{kind, priority, title, body, rivianAppUrl, signature}`. 11 unit tests covering every branch. |
| `b1bddb6` | feat (cron) | Cron logs recommendation on signature change. Persistence trick: signature is appended as a `[helios-sig:…]` marker on the action's `reason` field — gives dedup without a schema migration. `/api/actions` strips before the UI sees it. |
| `a4a9450` | feat | Web Push infrastructure. Migration `0013_push_subscriptions.sql`, `pushSubscriptions` Drizzle table, `public/sw.js` service worker, `lib/push.ts` send-side, `lib/push-client.ts` browser helpers, `/api/push/{vapid-public-key,subscribe,unsubscribe}` routes, `scripts/generate-vapid-keys.ts`. `web-push@3.6.7` added. |
| `39cb2a4` | feat (cron) | Fire Web Push on high-priority recommendations. 15-min throttle via `[helios-pushed:<iso>]` marker on the most recent recommendation. Throttle is independent of activity-feed dedup — banner + feed always update; only the lock-screen buzz is throttled. |
| `dd5d974` | feat | Dashboard `RecommendationBanner.tsx`. Polls `/api/recommendation` every 30s; renders only when `priority="high"` AND `kind!="noop"` AND not stale. Single CTA → `rivian://`. |
| `b2f0f3a` | feat | `NotificationsCard.tsx` on Settings. Six-state machine (loading / unsupported / denied / off / on / busy / error) with iOS-aware "open in Safari → Add to Home Screen" copy when needed. |
| `beccecf` | feat (settings) | Mark Rivian rows `read-only` with a small inline tag. Adds an expandable "Why are the Rivian rows read-only?" callout that explains the Apple Car Key wall in two paragraphs without dragging the user out to a separate doc. |

**Polish & bug fixes (post-implementation):**

| Commit | Type | Summary |
|---|---|---|
| `a8e63f8` | chore | `/api/admin/test-push` admin-gated route for round-trip Web Push verification. Used during bring-up; harmless to leave (21 lines, gated). |
| `da5637c` | fix | Hydration guard for SWR-driven dashboard (React #418). `mounted` sentinel pins first paint to a single deterministic state on both server and client. Pre-existing bug surfaced in dev mode. |
| `e6e0205` | fix | `getLearnedHomeCurve`: serialize `Date` to ISO before binding. The query was failing on every `/api/status` hit (silent fallback to static curve). ~100ms recovered per request, plus the engine starts using the actual learned curve. |
| `5f65085` | feat | Skeleton loading state replaces blank "loading…" text. `Skeleton.tsx` primitive + `DashboardSkeleton.tsx` six-card silhouette. Honors `prefers-reduced-motion`. |
| `24ebeba` | ui (activity) | Move Self-Sufficiency chart above the activity feed. Chart is the answer-at-a-glance; feed is the supporting "why." |
| `0eb8faa` | ui (history) | Default to Day view + tap-to-reveal value tooltip. Removes localStorage period persistence (always lands on Day). Tooltip shows label + % + kWh. |
| `70edb37` | feat (history) | Show **Spent** + **Credit** next to headline %. Both gross (not netted), summed across the selected window. Backend extends `getSelfSufficiencyHistory` with `import_usd` and `export_credit_usd`. |
| `167cad7` | ui (history) | Tooltip always renders ABOVE the bar (72px reserved zone above SVG). Global pointer-down dismiss anywhere outside the chart wrapper. Fixes mobile "finger obscures data" + "hard to dismiss" complaints. |

**Counts:** 18 commits. Build green at every checkpoint. 89/89 tests pass at session end.

## Architecture: Option B in one diagram

```
+---------------------------------------------------------------+
|  cron/decide/route.ts (every 5 min)                          |
|                                                              |
|  status = assembleStatus({forEngine: true})                  |
|  decision = decide({...})            // Powerwall reserve    |
|  evDecision = decideEvCharge({...})  // EV intent            |
|                                                              |
|  Tesla actuator: setBackupReserve(decision.target_reserve_pct)
|                  // STILL AUTONOMOUS - no manual step needed |
|                                                              |
|  recommendation = recommendEvAction({evDecision, snapshot})  |
|                                                              |
|  if (recommendation.signature !== lastSignature) {           |
|    appendRecommendation({...signature embedded in reason})  |
|    if (recommendation.priority === 'high' && !throttled) {   |
|      sendPushToAll({title, body, url: 'rivian://'})         |
|    }                                                         |
|  }                                                           |
+---------------------------------------------------------------+
                        |                       |
                        v                       v
            +-------------------+   +-------------------+
            |  Activity feed    |   |  Web Push (15min  |
            |  (signature       |   |  throttle, only   |
            |  dedup, on-page   |   |  for priority     |
            |  via /api/actions)|   |  ='high' + dedup) |
            +-------------------+   +-------------------+
                        |                       |
                        |                       v
                        |              +------------------+
                        |              |  iPhone PWA      |
                        |              |  /sw.js shows    |
                        |              |  notification    |
                        |              |  → tap →         |
                        |              |  rivian://       |
                        v              +------------------+
            +-------------------+              |
            |  Dashboard banner |              v
            |  (polls           |    +-------------------+
            |  /api/recommend-  |    |  Rivian app       |
            |  ation every 30s) |    |  (paired creds)   |
            +-------------------+    |  → user taps     |
                                     |  Stop / sets      |
                                     |  charge limit    |
                                     +-------------------+
```

## What works

- **End-to-end push round-trip on iOS PWA.** Verified 2026-05-01 ~14:54 PT: `/api/admin/test-push` → 200 with `{attempted:1, delivered:1}` → notification rendered on iPhone lock screen with correct title, body, and Helios icon → tap opened Rivian app via `rivian://` deep link.
- **Signature-based activity-feed dedup.** No schema migration needed; signature lives as a trailing `[helios-sig:...]` marker on the action's `reason` field. `/api/actions` strips before sending to the UI. `lastRecommendationSignature()` reads it back. Stable enough that a 30 ° change to the EV's SoC re-fires the recommendation, but a noisy 0.4 kW oscillation on the desired rate doesn't (rounded into 0.5 kW buckets).
- **Web Push + activity feed throttles independent.** The activity feed updates on every signature change (~once per 5–30 min while charging); push is gated to a min 15-min interval via a separate `[helios-pushed:<iso>]` marker. Banner + feed always show the latest data; the lock-screen buzz is the only thing throttled.
- **Skeleton loading state.** Six hand-tuned card silhouettes (Hero, Cost, Solar, EV, PW, Forecast) with a warm-palette diagonal shimmer. Layout doesn't shift when data arrives. `prefers-reduced-motion` disables the sweep automatically.
- **Self-Sufficiency card upgrades.** Defaults to Day on every visit; tap a bar (or hover on desktop) to see exact label + % + kWh; tooltip always renders above the bar so a tapping finger doesn't obscure the data; tap anywhere outside the chart to dismiss. Spent / Credit numbers (gross, not netted) summed across the selected window — answers a question that lived nowhere else in Eliel's ecosystem.

## What didn't work (and the fixes)

1. **Cookie-auth from `.env.local` for the test-push curl.** First attempt used `grep ^ADMIN_TOKEN=` to extract the cookie value — but `.env.local` didn't have an `ADMIN_TOKEN` line. The token only lived in Vercel env vars, and Vercel marks `ADMIN_TOKEN` as Sensitive, which means the value is unreadable from the dashboard after save. **Fix:** sign in via `/admin/login` in the laptop browser, then fire the test from devtools console with `fetch('/api/admin/test-push', {method:'POST'})` — the browser sends the auth cookie automatically. **Lesson:** when Sensitive vars block your debug path, switch to in-browser fetch from a signed-in session.

2. **Chrome devtools blocking pasted code.** Chrome refused the first paste with the standard "Don't paste code into DevTools Console" warning — a phishing-defense feature. **Fix:** type `allow pasting`, hit Enter, then paste again. **Lesson:** worth flagging this in any future debugging-from-console instructions; the warning is loud and confusing if you've never seen it.

3. **Hydration mismatch on dashboard (React #418).** The early-return ladder `if (isLoading) return loading; if (error) return failed` rendered different branches on server SSR vs client hydration in dev mode. **Fix:** `mounted` sentinel — both server and first client render unconditionally show the loading skeleton; the `error || !data` branch only checks after `useEffect` flips mounted. **Lesson (and rule of thumb for SWR-driven pages):** never branch on async state in the first render. Either pin to a single deterministic skeleton or use Suspense.

4. **`getLearnedHomeCurve` failed silently on every status request.** postgres-js rejects raw `Date` objects as parameter values (`TypeError: "string" argument must be of type string or Buffer`). The function caught the error and fell back to the static curve. Visible cost: ~100ms per `/api/status` from the failed roundtrip, plus the engine ran on the static curve instead of the learned one. **Fix:** `.toISOString()` before passing into the `sql` template. **Lesson:** silent fallbacks are quiet bugs; the failure was buried under "[status] Learned home curve failed, keeping static" log lines that nothing alerted on. Worth a follow-up to surface caught-but-noisy errors more prominently.

5. **Tooltip on bar chart was rendering BELOW tall bars.** First implementation used a `flipBelow` heuristic (when `value >= 70%` flip the tooltip below to avoid clipping at the top of the chart). On mobile this put the tooltip directly under the user's finger — defeating the entire point of the affordance. **Fix:** always above. Reserve 72px above the SVG (in the chart wrapper's `paddingTop`) so a 100% bar's tooltip still fits. **Lesson:** mobile-first matters for affordances that exist *because* of mobile (touch interactions). The "what if it clips" worry was solved by reserving space, not by flipping direction.

6. **Tooltip dismiss was hard to hit on mobile.** First implementation only dismissed on taps to blank space *inside* the chart — which is a small target on a phone. **Fix:** document-level `pointerdown` listener (only attached while a selection is active) treats the entire screen outside the chart wrapper as a dismiss target. **Lesson:** "tap-out" affordances on mobile need to be generous; small dismiss zones become rage-tap zones.

## Lessons (cross-cutting)

These are worth pinning beyond any single file or commit.

1. **A no-op stub between two reverts is a load-bearing cleanup pattern.** R2 (Smartcar V3 actuator gut) left no-op shells of `startCharging`/`stopCharging`/`setChargeLimit` so cron's `fireEvAction` still compiled. R3 then removed the stubs *together with* the call sites in cron. This kept the build green at every commit checkpoint, which let me run typecheck + tests as a sanity gate after each commit. The alternative (one giant revert) would have been faster to write but slower to verify and harder to bisect if something broke.

2. **Embedded markers > schema migrations for opaque per-row metadata.** The `[helios-sig:...]` and `[helios-pushed:...]` markers in `control_actions.reason` give us dedup state without a column add. The `/api/actions` strip-on-read keeps the UI clean. Trade-off: future maintainers have to know the markers exist; they're fragile to a careless `replace_all` on the reason field. For Helios's scale and single-tenant nature, the trade is fine — for a multi-tenant or production-graded system, a `signature` column would be the right call.

3. **Hydration mismatches surface in dev mode but ship to prod silently.** Dev mode's React shows a loud unminified error; prod just shows minified `#418` and a re-render. Worth the habit of running `npm run dev` against production-like data periodically to catch these before they ship.

4. **Skeleton loading states are 80% UX win for ~20% effort.** The DashboardSkeleton was ~150 lines; the perceived-load improvement is dramatic. The card-by-card hand-tuning matters — generic gray rectangles read as "fake," but headers + signal dots + bar-shaped silhouettes read as "real layout, values incoming." Same effort, fundamentally different feel.

5. **Always-above + outside-tap-dismiss is the universal mobile tooltip pattern.** Worth treating as a default for any future touch-target-with-overlay affordance in Helios. A `<Tooltip>` or `<Overlay>` primitive that bakes in (a) reserve zone above target, (b) fixed flip direction, (c) document-level dismiss listener would prevent re-discovering this pattern per component.

6. **Test-push utility routes pay for themselves.** `/api/admin/test-push` was 21 lines; without it, end-to-end Web Push verification would have meant waiting up to 5 min for a real engine state change, every iteration. Keeping it (admin-gated) is cheap and means the next bring-up — if VAPID keys rotate, if the SW changes, if a new device subscribes — is a single curl away.

## Strategic decisions locked

These resolve open questions and shape future work; surfacing them up top so future-me doesn't re-litigate.

1. **[LOCKED 2026-05-01] Option B is the design.** Helios is a decision engine with a recommendation surface, not an autonomous EV controller. The Tesla Powerwall reserve write is still autonomous (no OEM pairing wall there); the EV side is recommendation-only.
2. **[LOCKED] Web Push over Pushover.** Web standards (Service Worker + VAPID); routes through Apple's web-push-to-APNs bridge for iOS PWAs. The user already proved the iPhone receives push and the deep link works.
3. **[LOCKED] `rivian://` for deep linking on tap.** Confirmed working on iOS. Falls through to the Rivian web app on non-iOS / desktop, which is acceptable.
4. **[LOCKED] `signature` is the dedup key.** Embedded in `reason` as `[helios-sig:...]`. Stable string that changes only when the user-visible recommendation meaning changes (kind transition, SoC bump, rate-bucket shift).
5. **[LOCKED] 15-min push throttle.** Independent of activity-feed dedup. Banner + feed always update on signature change; only the lock-screen buzz is throttled.
6. **[LOCKED] Spent + Credit are gross, not netted.** Dashboard's CostCard already shows the net daily number; the Activity-page card adds the gross split because it's the answer that lives nowhere else in the user's ecosystem and gets more interesting at week/month/year scope.
7. **[LOCKED] Day is the default chart period on every page load.** Was persisting in localStorage, which meant repeat visitors landed on Year/Month and missed today's pattern.

## What does NOT need a strategic decision

Mechanical follow-ups for next session:

- **Surface caught-but-noisy errors.** The `getLearnedHomeCurve` Date bug ran undetected for some unknown amount of time because the failure path was a `console.error` inside a `try/catch`. A "caught error counter" surfaced in the data-health badge would have flagged it.
- **Address the other `new Date()`-in-render usage** in `SolarCard`, `CostCard`, `ForecastCard`, `FreshnessIndicator`. They happen to work because the dashboard now waits for `mounted` before rendering them, but they're fragile patterns. Worth refactoring to a shared `useNow()` hook initialized in `useEffect`.
- **Move `mockStatus()` out of production bundle** — env-gated import or test-only file. The 4/29 postmortem's structural fix; still pending.
- **Wrap remaining DB-touching cron calls** (`writeSnapshot`, `secondsSinceLastAction`, stale-gate `appendAction`).
- **Push-notification stale-subscription cleanup job.** `lib/push.ts` already purges `404`/`410` subscriptions on send. A separate scheduled cleanup that prunes subscriptions with no `last_used_at` in 30 days would be tidy.
- **`/api/recommendation` could cache for 30s.** It re-runs the full `assembleStatus` on every call, which is 3–6 seconds of provider fetches. The banner polls every 30s; a 30s server-side cache would reduce load by ~10× without affecting freshness.
- **Surface `oemUpdatedAt` in source-status plumbing.** V3 signals carry per-signal staleness; Helios's existing source-status only tracks "live/unavailable/mock" at the provider level. Not urgent until a stale-data incident.
- **Add `morning_bridge_floor_pct` to Settings UI** — currently API-only (~15 min).

## Vocabulary introduced this session (added to `engineering-primer.md` glossary on next consolidation)

- `Web Push` — W3C standard for delivering push notifications to a browser/PWA. Requires a Service Worker, a VAPID keypair, and a `pushManager.subscribe()` flow on the client.
- `VAPID` — *Voluntary Application Server Identification.* Lets push services (FCM, APNs bridge, etc.) rate-limit or contact senders. Public key embedded in client subscription; private key signs each push.
- `Service Worker` — JS file that runs in the background even when the PWA is closed. Required for receiving push events on the user's device.
- `pushManager.subscribe()` — browser API that returns a `PushSubscription` with `{endpoint, keys}`. The endpoint is unique per device.
- `signature` (Helios-internal) — stable string from `recommendEvAction` that changes only when the user-visible recommendation meaning changes. Used to dedup activity-feed entries and pushes.
- `tag` (Web Push) — collapse-key on the lock screen. Same tag → most recent notification replaces previous.
- `Apple Car Key` — Apple Wallet credential bound to the Secure Enclave on a specific Apple ID. The wall blocking every cloud + BLE actuation path on Gen 2 R1S.
- `Standalone PWA` — what you get when the home-screen icon is opened (not a Safari tab). On iOS, push notifications + serviceWorker.pushManager *only* work in standalone mode.
- `Hydration mismatch (React #418)` — when server-rendered HTML differs from what the client renders during hydration. Common SWR-on-page failure mode.
- `Mounted sentinel` — `useState(false) + useEffect(() => setMounted(true), [])` pattern that lets a client component pin its first paint to a single deterministic state, avoiding hydration mismatches.

## Production state at session end

```
2026-05-01 (afternoon PT, after Web Push end-to-end verification + UI polish)

Production code: deployed at commit 167cad7 — full Option B + Web Push + UI polish.
Database: migration 0013_push_subscriptions.sql applied.
Vercel env vars: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
  all in Production + Preview environments.

Push subscription state: 1 subscription in push_subscriptions table
  (Eliel's iPhone PWA). Verified delivery via /api/admin/test-push.

Recommendation pipeline: live. Cron computes recommendEvAction every
  5 min, logs to activity feed on signature change, fires Web Push on
  high-priority changes (15-min throttle).

Activity feed: chart-on-top layout. Self-Sufficiency card defaults to
  Day, shows Spent/Credit alongside the headline %, tap-to-reveal
  tooltip always above bar with global tap-out dismiss.

Confirmed-impossible (still): cloud-only or local-BLE charging-command
  authority for the Rivian R1S Gen 2 (Apple Car Key constraint).

Manual stop authority: unchanged — open Rivian app → Charging → set
  charge limit at-or-below current SoC. Banner + push now point users
  at this flow when the engine recommends a stop.
```

## Files most relevant to next session

- `app/src/lib/recommendEvAction.ts` + `recommendEvAction.test.ts` — pure translator. Edit if you want to refine recommendation copy or change priority rules.
- `app/src/app/api/cron/decide/route.ts` — cron loop. Reserve write is autonomous; EV branch is recommendation-only.
- `app/src/lib/push.ts` — server-side `sendPushToAll`. Edit for payload changes.
- `app/src/lib/push-client.ts` — browser-side subscribe/unsubscribe helpers.
- `app/public/sw.js` — service worker. Push handler + notification click → deep link.
- `app/src/lib/db.ts` — `appendRecommendation`, `lastRecommendationSignature`, `lastPushTimestamp`, `stripSignatureMarker`. The marker convention lives here.
- `app/src/components/cards/RecommendationBanner.tsx` — dashboard banner.
- `app/src/components/cards/NotificationsCard.tsx` — Settings notifications card.
- `app/src/components/cards/IntegrationsCard.tsx` — read-only callout for vehicle providers.
- `app/src/components/DashboardSkeleton.tsx` + `Skeleton.tsx` — loading skeletons.
- `app/src/components/cards/SelfSufficiencyHistoryCard.tsx` — Activity-page chart with tooltip + Spent/Credit.
- `app/src/app/api/admin/test-push/route.ts` — round-trip Web Push test endpoint, kept for future bring-up.

## Things to NOT do next session

- **Don't reintroduce EV actuators on this car.** Apple Car Key is the wall; it's been empirically verified. Any "what if we just tried…" instinct should route through `memory/project_apple_car_key_block.md` first.
- **Don't drop the `mounted` sentinel from the dashboard page.** Pre-existing bug, but it's load-bearing now for clean SSR/CSR parity.
- **Don't forget to redeploy after Vercel env-var changes.** The session lost ~15 min to "added the VAPID vars but didn't redeploy" — Vercel doesn't auto-rebuild on env-var-only changes.
- **Don't change the `[helios-sig:...]` / `[helios-pushed:...]` marker conventions without updating both the appender (db.ts) and the strip-on-read (api/actions).** They're a paired contract; breaking one corrupts the activity feed display or the dedup logic.
- **Don't add another caught-and-logged-but-ignored error path without a counter.** The `getLearnedHomeCurve` bug is the canonical example of how silent fallbacks become quiet bugs.
- **Don't trust API success as physical-state confirmation.** The 4/30 postmortem's verification-loop discipline still applies to anything the engine actuates (Tesla reserve, future actuators on different vehicles).
