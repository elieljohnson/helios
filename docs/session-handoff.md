# Session handoff — 2026-07-03 (design-system pass)

Latest handoff. Purely visual work this session — surfaces, tokens, and control styling. Full narrative + lessons in `docs/postmortems/2026-07-03-design-system-pass.md`. The 2026-05-01 engine handoff (Option B, Web Push, and the open engine follow-ups) is preserved below the divider and is still current — none of it changed this session.

## Headline state

- **A full visual-system overhaul shipped and is live.** Warm-cream → neutral-gray surfaces, a real dark mode (system default + manual override), and every control standardized to white/grey/black. Seven commits, `2a9e96c`..`c46299f` on `main`, Vercel READY, eye-verified on `helios-eliel.vercel.app`.
- **No engine, decision, cron, provider, schema, or migration changes.** Production behavior is exactly as the 2026-05-09 postmortem left it.
- **Build green, `tsc` clean.** No open bugs from this session.

## What's deployed

```
Latest commit: c46299f  style(controls): white buttons, appearance track, and read-only banner
Deploy:        dpl_DmMk… READY, target production, alias helios-eliel.vercel.app
Migration:     none added this session
Theme storage: localStorage key "helios-theme" (system|light|dark), per-device
```

## Design conventions now in force (follow when building UI)

1. **Semantic energy colors are for data, not chrome.** `--solar/--battery/--vehicle/--grid/--home/--alert` go on bars, rings, status text, net-cost figures — never to fill a control.
2. **Surfaces are neutral gray**, token-driven: page `--surface-deep` `#E6E6E6`, cards `--surface-card` white, inset `--surface-inset` `#E2E2E5`. No warm tones remain.
3. **Controls are white + `--hairline` keyline; black (`--text-primary`) fill = selected/active only** (toggle on, day active, segment selected). Text on black fill and toggle knobs use `--surface-card`, never hardcoded `white` (it vanishes on the dark-mode track).
4. **Build with tokens, not hexes**, so new UI adapts to dark automatically.

Dark mode: `.theme-dark` on `<html>` flips the tokens; state in `lib/theme.ts`, control in `components/ThemeControl.tsx`, no-flash script + `theme-color` meta in `layout.tsx`, shared colors in `lib/themeColors.ts`.

## Gotchas that cost time (read before debugging)

- **Token change not rendering in dev?** Turbopack caches compiled CSS chunks; reloads and a `next dev` restart won't clear them — `rm -rf app/.next` and restart. TSX hot-reloads fine; CSS-variable values get stuck.
- **Config-gated Settings UI won't render locally** — the local Neon credential fails auth, so `/api/config` and `/api/integrations` 500 and Settings shows `loading config…`. The switches, policy form, banner, badges, and notifications button are only eye-verifiable on production. Drive real production with the claude-in-chrome MCP (the built-in preview browser is localhost-only). Anonymous = the read-only demo view.
- **Adding a pre-paint inline script?** Use `next/script strategy="beforeInteractive"`, not a raw `<script>` in JSX — React 19 warns on the latter.

## Open follow-ups from this session (quality-of-life, not bugs)

- Eye-verify the admin **"Save changes"** button (white) once signed in — only renders in the editing state.
- Glance at the installed **iOS PWA status bar** in dark mode on the actual phone; the installed-app bar can't switch live (known iOS limit), though Android and in-browser iOS follow.
- Stale `/* warm/precise */` comment at the top of `globals.css`.
- Dead props parked for possible reuse: `signal` on `Card.tsx` / `DashboardSkeleton.tsx`; `buttonVariant` on `NotificationsCard`.

---

# Session handoff — 2026-05-01 (afternoon, post-Option-B-ship)

Picks up where the morning's `docs/postmortems/2026-05-01-option-b-implementation.md` leaves off. That postmortem has the full strategic + lessons-learned narrative; this doc is the operational handoff for the next session.

## Headline state

- **Option B is shipped, deployed, and working.** Helios is now a decision engine that surfaces stop/start as recommendations via dashboard banner + Web Push. The user actuates manually via the Rivian app.
- **Web Push verified end-to-end on iPhone PWA.** Server → push service → device → SW → notification → tap → Rivian app via `rivian://` deep link. Round-trip proven 2026-05-01.
- **Tesla Powerwall reserve write is still autonomous.** Only the EV side became recommendation-only. The Tesla Fleet API doesn't have an OEM pairing wall.
- **All actuator paths to the Rivian R1S Gen 2 are empirically closed:** Rivian unofficial command API, Smartcar V3 commands, local BLE. Detail: `memory/project_apple_car_key_block.md`.
- **No open work blocking the next session.** Everything in `main` is deployed; build green; 89/89 tests pass. The follow-ups in this doc are quality-of-life and deferred maintenance, not bugs.

## What's deployed (production state)

```
Latest commit: b9f71b2  fix(integrations): drop live Enphase Summary ping
Migration:     0013_push_subscriptions.sql applied
Vercel env:    VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT live in Production + Preview
Subscriptions: 1 row (Eliel's iPhone PWA)
System specs:  16.1 kW DC solar / 13.3 kW AC clip / 40.5 kWh PW3 / 21,660 kWh year-1 estimate
```

The full session arc — 22+ commits across 3 reverts + 8 build commits + 7 polish/UX + 1 engine fix + system-spec corrections + forecast/Enphase quota fixes — is enumerated in `docs/postmortems/2026-05-01-option-b-implementation.md` under "What shipped."

## How Option B works

```
                                cron/decide/route.ts (every 5 min)
                                          │
                  ┌───────────────────────┼─────────────────────────┐
                  ↓                                                  ↓
        Powerwall reserve                                  recommendEvAction()
        (autonomous, Tesla)                                          │
        setBackupReserve()                                signature unchanged?
                                                                     │
                                              ┌──────────────────────┴─────────┐
                                              ↓                                ↓
                                   Skip (5-min wallpaper)             Append to feed
                                                                              │
                                                                  priority="high" + 15-min
                                                                  since last push?
                                                                              │
                                                                ┌─────────────┴─────────┐
                                                                ↓                       ↓
                                                  sendPushToAll() → iPhone     Skip push
                                                                                (banner + feed
                                                                                 still update)

Reads (poll every 30s):                Reads (poll every 60s):
  /api/recommendation                   /api/actions
        ↓                                       ↓
RecommendationBanner               Activity feed (Activity page)
(dashboard, Home page)
```

**Key design choices, all locked:**

- Recommendation `signature` (`stop:high:soc64`, `start:high:rate7.5`, etc.) is the dedup key. Embedded in `control_actions.reason` as `[helios-sig:…]`; stripped at the API edge for display.
- Push throttle is independent of activity-feed dedup. Feed updates on every meaningful state change; push fires once per 15 min max.
- `rivian://` deep link confirmed working on iOS. The notification body is action-oriented copy: *"Stop EV charging now. Car is currently drawing 7.8 kW. Open the Rivian app → Charging → set the limit to 64%, or unplug."*
- `Day` is the default chart period on every page load. Was persisting in localStorage; users were missing today's pattern.

## Open follow-ups (priority ordered)

These are not blocking; they're the next wave of polish + deferred maintenance.

1. **[P1] Surface caught-but-noisy errors.** The `getLearnedHomeCurve` Date bug ran undetected because the failure path was a `console.error` inside `try/catch`. A "caught error counter" surfaced in the data-health badge would have flagged it earlier. Same shape for any other silently-caught provider failures.
2. **[P1] Cache `/api/recommendation` for 30s server-side.** Endpoint re-runs full `assembleStatus` (3–6s of provider fetches) on every banner poll. Banner polls every 30s; a 30s cache reduces backend load by ~10× without affecting freshness.
3. **[P2] Refactor `new Date()`-in-render usage** in `SolarCard`, `CostCard`, `ForecastCard`, `FreshnessIndicator`. They happen to work because the dashboard now waits for `mounted`, but the pattern is fragile. A shared `useNow()` hook initialized in `useEffect` would be cleaner and prevent future hydration whack-a-mole.
4. **[P2] Stale-subscription cleanup job.** `lib/push.ts` purges 404/410 subscriptions on send. A scheduled cleanup that prunes any subscription with no `last_used_at` in 30 days would be tidy. Low priority — single-tenant app, only Eliel subscribes.
5. **[P2] Move `mockStatus()` out of production bundle.** Env-gated import or test-only file. The 4/29 postmortem's structural fix; still pending.
6. **[P2] Wrap remaining DB-touching cron calls** (`writeSnapshot`, `secondsSinceLastAction`, stale-gate `appendAction`).
7. **[P2] Surface `oemUpdatedAt` in source-status plumbing.** V3 signals carry per-signal staleness; Helios's existing source-status only tracks "live/unavailable/mock" at the provider level.
8. **[P2] Cron gate should include `vehicle` source.** Currently checks solar/home/powerwall; a phantom EV-state actuation risk exists for users with Tesla up but no WC + no Rivian. Needs a `not_configured` vs `unavailable` distinction so PW-only users don't get over-blocked.
9. **[P2] Split `vehicle` source into charger-side + car-side.** Tesla owns charger fields (`ev_w`, `ev_charging`, `ev_plugged_in`); Rivian/Smartcar own car fields (`ev_soc`, `ev_target`, `ev_range`). Current single tag conflates them.
10. **[P2] `pw_reserve` from Tesla `site_info` has nested try.** site_info-failure leaves `pw_reserve` mock-derived while `sources.powerwall` is `live`. Engine reads it for `should_act`.
11. **[P3] Add `morning_bridge_floor_pct` to Settings UI** — currently API-only (~15 min).
12. **[P3] Extract a `<Tooltip>` / `<Overlay>` primitive** with always-above + outside-tap-dismiss baked in. Currently bespoke in `SelfSufficiencyHistoryCard`; would prevent re-discovering the mobile pattern per component.
13. **[~] Optional: clean up dormant `command_*` fields in `oauth_tokens.meta` row.** Run `disenrollPhone` mutation against Rivian + clear the meta fields. Rivian-app phone-key entry already removed. Currently dormant and harmless.

## Things to NOT do next session

Direct from `2026-05-01-option-b-implementation.md` "Things to NOT do" — restated here so they're impossible to miss:

- **Don't reintroduce EV actuators on this car.** Apple Car Key is the wall; it's been empirically verified by three independent paths. Any "what if we just tried…" instinct should route through `memory/project_apple_car_key_block.md` first.
- **Don't drop the `mounted` sentinel from the dashboard page.** Pre-existing bug, load-bearing now for clean SSR/CSR parity.
- **Don't forget to redeploy after Vercel env-var changes.** They don't trigger an auto-rebuild.
- **Don't change the `[helios-sig:…]` / `[helios-pushed:…]` marker conventions without updating both the appender (db.ts) and the strip-on-read (api/actions).** Paired contract.
- **Don't add another caught-and-logged-but-ignored error path without a counter.**
- **Don't trust API success as physical-state confirmation.** Verification-loop discipline from 4/30 postmortem still applies to autonomous actuators (Tesla reserve, future actuators on different vehicles).

## Files most relevant to next session

(Same list as the postmortem; restating here so you don't have to flip docs.)

- `app/src/lib/recommendEvAction.ts` + tests — pure recommendation translator
- `app/src/app/api/cron/decide/route.ts` — cron loop; reserve autonomous, EV recommendation-only
- `app/src/lib/push.ts` — server-side `sendPushToAll`
- `app/src/lib/push-client.ts` — browser-side subscribe/unsubscribe
- `app/public/sw.js` — service worker (push + notification click)
- `app/src/lib/db.ts` — `appendRecommendation`, `lastRecommendationSignature`, `lastPushTimestamp`, `stripSignatureMarker`
- `app/src/components/cards/RecommendationBanner.tsx` — dashboard banner
- `app/src/components/cards/NotificationsCard.tsx` — Settings notifications card
- `app/src/components/cards/IntegrationsCard.tsx` — read-only callout
- `app/src/components/DashboardSkeleton.tsx` + `Skeleton.tsx`
- `app/src/components/cards/SelfSufficiencyHistoryCard.tsx` — Activity-page chart
- `app/src/app/api/admin/test-push/route.ts` — bring-up test endpoint, kept

## Quick reference: common operations

```bash
# Run the test push (signed-in browser → devtools console):
fetch('/api/admin/test-push', { method: 'POST' }).then(r => r.json()).then(console.log)

# Generate new VAPID keys (if rotating):
cd /Users/Eliel/Projects/Helios/app
npx tsx scripts/generate-vapid-keys.ts
# → paste output into .env.local AND Vercel env vars
# → click Redeploy on Vercel (env-var changes don't auto-rebuild)

# Apply a new migration:
cd /Users/Eliel/Projects/Helios/app
npm run db:migrate
npm run db:migrate:status  # confirm

# Local dev with prod DB:
cd /Users/Eliel/Projects/Helios/app
npm run dev

# Typecheck + tests:
cd /Users/Eliel/Projects/Helios/app
npx tsc --noEmit && npx vitest run
```

## Reference: full session arc (just enumeration; analysis is in the postmortem)

**Reverts (R1–R3):**
- `7ecb23d` — Rivian v5 command-API surface gone
- `f94ab57` — Smartcar V3 actuators stubbed (no-op for cron compat)
- `b50b658` — cron's EV actuator chain dropped; verifyEvAction deleted

**Build (B1–B8):**
- `3b255ef` — `recommendEvAction()` pure function + 11 tests
- `b1bddb6` — cron logs recommendation on signature change
- `a4a9450` — Web Push infrastructure (migration, SW, send/client, routes)
- `39cb2a4` — cron fires push on high-priority change (15-min throttle)
- `dd5d974` — dashboard `RecommendationBanner`
- `b2f0f3a` — Settings `NotificationsCard`
- `beccecf` — Settings: Rivian rows tagged read-only + "why?" callout
- (B8 was Settings header subtitle update, bundled with B7)

**Polish (post-implementation):**
- `a8e63f8` — `/api/admin/test-push` route for round-trip verification
- `da5637c` — hydration guard for dashboard (React #418)
- `e6e0205` — getLearnedHomeCurve Date→ISO fix
- `5f65085` — DashboardSkeleton replaces "loading…" text
- `24ebeba` — Activity page: chart above feed
- `0eb8faa` — SelfSufficiencyHistoryCard: default Day + tap-to-reveal tooltip
- `70edb37` — Spent + Credit headline numbers (gross, summed by period)
- `167cad7` — Tooltip always above bar + global tap-out dismiss

**Engine fix (post-polish):**
- `9a6461b` — `decideEvCharge` skips remaining-window budget check when PW is at/above target. Was returning "stop with PW protection" reasoning even at 100% PW, because the budget check ran before the PW-state branch. New "would drain Powerwall" messaging with live drain rate when applicable.

**System-spec corrections (after pulling the stamped install plans):**
- `26412ab` → `0411dc8` → `9de1af0` — three iterations to land on the right numbers. Final values: 16.1 kW DC nameplate, 14.82 kW CEC-AC weighted, 13.3 kW AC inverter ceiling (35 × Enphase IQ8X-80 @ 380 VA each), 40.5 kWh of Tesla Powerwall 3 storage on a full-house backup config (2× Backup Gateway 3), year-one estimate 21,660 kWh @ 154% offset. Updated mock.ts, all three case-study docs, and persistent memory.

**Forecast + Enphase quota fixes (surfaced by user questions):**
- `5c780df` — `SYSTEM_PEAK_KW` constant in `weather.ts` was hardcoded at 9.5 (legacy from when system was thought smaller). Forecast was systematically scaling Open-Meteo's irradiance to ~71% of reality, biasing `decideEvCharge` toward premature stops. Bumped to 13.3 to match the AC inverter clip ceiling.
- `9535f7e` — Enphase `consumption_meter` URL embedded a moving timestamp (`Math.floor(Date.now()/1000) - 7200`) that changed every second. Next.js fetch cache keys on URL → every call generated a unique URL → cache was completely defeated. Fixed by rounding `start_at` to a 15-min bucket. Also bumped cache TTL 5 → 15 min and corrected the "1000/day" comment to "1000/month" (the real Watt-plan limit).
- `b9f71b2` — `/api/integrations` was doing a live `getSummary` ping on every poll. With Settings open in any tab, that's 60 calls/hour to Enphase = ~43,000/month potential, which is what blew the quota. Replaced with a token-existence check; the row stays green when connected, just doesn't show the redundant "X.XX kW now" number (live solar production already shows on the dashboard SOLAR card via Tesla).

The full reasoning, lessons, and architecture for each lives in `docs/postmortems/2026-05-01-option-b-implementation.md`.
