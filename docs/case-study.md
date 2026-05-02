# Helios — A home energy intelligence system

**A senior design leader's case study in scoping, building, and shipping a real-time multi-vendor decision engine for a solar / battery / EV home — solo, in eight days.**

> *"I'm a senior design leader, 30 years in. I'm a beginner at code. And I just shipped a production-grade home energy system that talks to four vendor APIs, runs every five minutes, surfaces real-time recommendations to my phone, and saves my family money on every sunny day."*

---

## TL;DR

Helios is a working web application that orchestrates the energy decisions for one specific Mill Valley home — mine and my wife's — running a 16.1 kW DC solar array (35× REC 460W panels, 35× Enphase IQ8X-80 micro-inverters with a 13.3 kW AC clipping ceiling), 40.5 kWh of Tesla Powerwall 3 storage on a full-house backup config (two Backup Gateway 3 units), and a 2025 Rivian R1S on PG&E's NEM 3.0 tariff. Every five minutes it pulls live telemetry from four vendor APIs, runs a tariff-aware decision engine, autonomously controls the Powerwall reserve, and pushes timely "open the Rivian app to do X" recommendations to my iPhone via Web Push.

| Metric | Value |
|---|---|
| **Calendar days** | 8 (April 24 → May 1, 2026) |
| **Commits** | 145 |
| **Lines of TypeScript** | ~13,900 in `app/src` (app code) + 1,635 in tests |
| **Unit tests** | 89, all passing |
| **API routes** | 29 |
| **DB migrations** | 13 |
| **Vendor APIs integrated** | 5 (Tesla Fleet, Enphase v4, Rivian GraphQL, Smartcar V3, Open-Meteo) |
| **Postmortems written** | 3 (one for each real-money incident or strategic pivot) |
| **Production incidents survived** | 2, both with full timeline + root-cause docs |
| **Strategic pivots locked from negative findings** | 1 (Option B — decision-engine architecture) |
| **Live at** | [helios-eliel.vercel.app](https://helios-eliel.vercel.app) |

---

## SOAR (the hero's journey, in one frame)

**Situation.** A heterogeneous solar home: a 16.1 kW DC array (35× REC 460W panels) paired with 35× Enphase IQ8X-80-M-US micro-inverters that cap AC output at exactly 13.3 kW (35 × 380 VA, by design); two Tesla Powerwall 3 units plus a Powerwall 3 Expansion battery for 40.5 kWh of storage on a full-house backup config (two Tesla Backup Gateway 3 units, every circuit on PW during an outage); a 2025 Rivian R1S that lives on a Tesla Universal Wall Connector; a household on PG&E's NEM 3.0 tariff. Every system has a vendor app. *None of them talk to each other.* And NEM 3.0 turned the economics asymmetric: imports cost $0.36–$0.58/kWh; exports earn ~$0.04/kWh. A 14× penalty for getting the orchestration wrong, every single peak-hour kWh.

**Obstacle.** No off-the-shelf product makes coordinated decisions across all three. The closest contenders are $5K+ hardware add-ons that still don't model NEM 3.0 natively or pre-charge the EV from forecast. Worse: the most strategically valuable action — *stopping the EV at the right moment* — turned out to require a hardware-level pairing credential bound to a specific Apple iPhone's Secure Enclave, not anything a cloud automation can reach. I learned this only by trying three independent paths and running each to empirical failure.

**Action.** Built a Next.js + Postgres + Vercel system end-to-end as a beginner coder, leaning on disciplined practice instead of skill: regression test for every bug, postmortem for every incident, atomic commits with conventional prefixes, empirical probes for every uncertain API call. Integrated five vendor APIs across three OAuth flows + one M2M auth + one unofficial reverse-engineered GraphQL gateway. When three independent actuator paths empirically failed (Rivian unofficial command API, Smartcar V3 commands, local BLE), I ran a feasibility spike on the BLE one — a ~5-hour Python detour to scan the air for any Rivian device — and accepted the negative result. Pivoted the architecture cleanly to "decision engine with manual-action UX," shipped Web Push notifications with a service worker, and verified the full round-trip on my own iPhone PWA.

**Result.** A real product solving a real problem. The Powerwall reserve is autonomously managed; my wife and I get a single notification on our lock screen *exactly when* the engine wants the EV stopped, with a one-tap deep link into the Rivian app. The recommendation system has signature-based dedup (no spam) and 15-minute throttling (no buzz fatigue). Activity-feed entries are honest about what was a recommendation vs. an autonomous action. The decision engine itself is portable — if I ever switch the EV to a Tesla, only the actuator layer changes. And every "we tried X and it didn't work" finding is captured in a memory file or postmortem so the next person (or AI agent) starting from this codebase doesn't re-investigate dead paths.

The metric that matters: **on a sunny day with the car at home, our daily cost is ~$0.00 and the system runs without us touching it.** On a not-sunny day, my phone tells me what to do, and I do it. We stopped fighting our own house.

---

## Why I built it

> **Without the asymmetry in the state's tariff, the grid is an infinite battery and Helios isn't necessary. With it, every hour has different value, and the orchestration layer becomes load-bearing.**

That sentence is the whole product thesis.

Under symmetric pricing — the way net metering used to work — the grid itself is your battery. You push when you have surplus; you pull when you need it; the meter nets you out. Time doesn't matter. Forecasts don't matter. Schedules don't matter. A house with solar and an EV runs *as if* it had infinite storage, because the grid plays that role for free. No vendor app needs to talk to any other one, because the timing of when you produce versus consume is economically invisible.

NEM 3.0 broke that symmetry.

| | Old (NEM 2.0) | New (NEM 3.0) |
|---|---|---|
| Export pays | ~$0.40/kWh (retail) | ~$0.04/kWh (flat ACC) |
| Peak import costs | ~$0.40/kWh | ~$0.58/kWh |
| Effective storage of "surplus → later use" | grid (free, infinite) | your own battery (you bought it) |
| Timing of generation vs. consumption | doesn't matter | matters by **14×** |

The state asked homeowners to install solar — and many of us did. The tariff structure then made the math punish us for using it the obvious way (push surplus to grid, pull later). Every kWh imported at peak now costs roughly fourteen kWh of export credit you'll never get back. The grid stopped being a battery and started being a one-way drain priced at 14×.

So now timing matters. And every minute of timing requires an orchestration layer the homeowner has to either buy or build, because the policy stopped providing one.

The strategically correct behavior under NEM 3.0 is precise:

1. Charge the Powerwall to ~80% by sunset minus one hour
2. Charge the EV from solar surplus, but never at the expense of Powerwall headroom
3. Stop the EV at its limit (typically 80% for battery longevity) unless tomorrow's solar is weak
4. On non-parked days when the car leaves mid-morning, prioritize the EV first — solar refills the battery either way
5. Never import from grid during peak hours unless a true emergency

No vendor product makes those decisions across the three systems. **Tariff-aware scheduling, multi-vendor optimization, forecast-driven planning** — that's the gap NEM 3.0 created and that no off-the-shelf product fills today.

So I built it.

In 2025 I installed a 16.1 kW DC solar array (35× REC 460W modules paired with 35× Enphase IQ8X-80-M-US micro-inverters; AC production caps at exactly 13.3 kW because that's 35 × 380 VA by design, year-one estimate 21,660 kWh, 154% offset of household consumption — intentionally oversized to feed the EV), two Tesla Powerwall 3 units plus a PW3 Expansion battery (40.5 kWh total) on a full-house backup config, and switched our daily driver to a Rivian R1S. Each system shipped with its own app — Tesla, Rivian, Enphase. None talked to each other. None knew about the others' constraints. The asymmetric tariff is what turned that vendor isolation from "mildly inconvenient" into a daily 14× tax on getting timing wrong.

If California ever rewires NEM 3.0 to restore symmetric pricing, Helios's decision engine becomes obsolete on the same day. That's a feature, not a bug. The product exists because the policy is broken; if the policy gets fixed, the product was a transitional layer worth building anyway.

---

## The strategic frame (product before engineering)

The first decisions weren't engineering decisions, they were product decisions.

### Build vs. buy

Surveyed the landscape:
- Span Panel ($5K + install)
- Lumin Smart Panel ($3.5K)
- Sense Solar (read-only)
- Home Assistant + community blueprints (deep YAML, no NEM 3.0 model)
- Tesla's own scheduler (Powerwall-only, oblivious to EV and forecast)

None handled NEM 3.0 natively. None combined Tesla + Rivian + forecast-driven scheduling. The build cost (my time) versus the buy cost (six months of waiting for someone else's roadmap) made the call obvious.

### Scope: personal first, portfolio second

Made the call early: this is for our actual house. Not generic SaaS, not multi-tenant. **One home, mine.** That single constraint cascaded into dozens of simplifications:

- No user accounts. One implicit user.
- No tenant isolation. Single Postgres row for config.
- No billing, no cohorts, no analytics.
- The "admin" page is gated by a single shared cookie token.
- Mock data is honest about being mock; live data is honest about being live; the UI shows the difference.

This is a senior-PM move: **constrain ruthlessly to the actual user, defer the multi-tenant problem until you have multi-tenants.** The constraint freed up a week of real engineering on the actual decision engine.

### Stack picked for one designer to own

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 16 App Router | Single repo for UI + API. No infra split. |
| Hosting | Vercel | Push to main = deploy. Cron via `vercel.json`. |
| Database | Neon Postgres + Drizzle ORM | Postgres because the math needs joins; Drizzle because raw types. |
| State | SWR | Simple, declarative, PWA-aware. |
| Styling | Tailwind v4 + design tokens | Fast iteration, design-system-aware. |
| Tests | Vitest | Fast, ESM-native. |
| Package count | 9 production deps, 12 dev deps | Lean by design — every dep is justified. |

---

## Architecture

```
                                  Every 5 min (Vercel Cron)
                                            │
                                            ↓
                              ┌─────────────────────────┐
                              │   /api/cron/decide      │
                              │   (decision engine)     │
                              └────────────┬────────────┘
                                           │
                  ┌────────────────────────┼─────────────────────────┐
                  ↓                        ↓                          ↓
          assembleStatus()           decide()                  decideEvCharge()
          (multi-vendor              (PW reserve target)       (EV intent)
           snapshot)                                                  │
                  │                        │                          │
                  ↓                        ↓                          ↓
       ┌──────────┴────────────┐    ┌──────┴─────┐         ┌──────────┴────────┐
       │ • Tesla Fleet (PW,    │    │ Tesla:     │         │ recommendEvAction │
       │   solar, WC, load)    │    │ setBackup  │         │ (pure translator) │
       │ • Enphase v4 (solar)  │    │ Reserve    │         │                   │
       │ • Rivian GraphQL      │    │ AUTONOMOUS │         │ Activity feed +   │
       │ • Smartcar V3 (fall-  │    └────────────┘         │ Web Push          │
       │   back vehicle reads) │                            │ RECOMMENDATIONS   │
       │ • Open-Meteo forecast │                            │                   │
       └───────────────────────┘                            │ User actuates     │
                                                            │ via Rivian app    │
                                                            └───────────────────┘
```

The engine is a pure function. Every input it consumes (snapshot, config, forecast, learned home curve) is observable; every output (action, reasoning chain, desired rate) is loggable; every decision can be replayed against historical state.

---

## The journey, in commits

**Day 1–2 (Apr 24–25):** Scaffolding, Open-Meteo forecast wiring, sunset-aware EV charging engine v1, Settings UI for the policy knobs.

**Day 3 (Apr 26):** Tesla Fleet API integration — Powerwall reads + reserve writes. Enphase OAuth + consumption-meter overlay.

**Day 4 (Apr 27):** Smartcar EV integration v1 (V2 API). Wall Connector telemetry ingest. Mobile readability pass.

**Day 5 (Apr 28–29):** Activity page polish, derived-status semantics, freshness indicators. **First production incident.** Mock data masqueraded as real for 8 hours overnight; engine fired a 32A charge schedule against phantom solar values; ~$6.73 in unintended grid imports + Powerwall drained to floor before manual intervention. Wrote first postmortem same day. Codified the "fail loudly, never to plausible-looking values" rule into `AGENTS.md`.

**Day 6 (Apr 30):** Rivian-direct GraphQL integration (read-side). Phase 2b: Rivian charging actuator wired. **Second production incident at 19:23 PT.** "Stop charging" wasn't actually stopping the car — turns out the unofficial schedule API was *adding active charge windows* that the car then honored at full rate during peak. ~$1.30 lost at peak, two manual interventions. Wrote second postmortem. Codified the "tariff-environment assumptions are not invariants" rule into `AGENTS.md`.

**Day 7 (May 1, morning):** Built Rivian command-API v5 end-to-end (4 commits: ECDH/HKDF/HMAC crypto primitives, phone-key enrollment, sendVehicleCommand wrapper, post-stop verification loop). 11 unit tests. Live test against the actual car — `state:4 / responseCode:1047 (paired-key required)`. *Cloud auth is necessary but not sufficient; physical BLE pairing is required.* Helios runs on Vercel. No Bluetooth. Pivoted to Smartcar V3 commands. Live test — `409 DEVICE_PAIRING_REQUIRED`. **Same OEM-level pairing constraint, different protocol.** Ran a 5-hour BLE feasibility spike with `bretterer/rivian-python-client`. Result: no Rivian peripheral broadcasts at all. Inference (later confirmed): Gen 2 R1S uses Apple Car Key, secure-enclave-bound, cannot be initiated from any non-Apple-enclave device.

> Three independent paths to charging-command authority — all empirically closed. The architecture's ceiling was hardware, not software.

**Day 7 (May 1, afternoon):** Wrote the Apple Car Key block memo. Locked the strategic decision: **Option B — Helios as a decision engine with manual-action UX.** Reverted v5 + Smartcar V3 actuator code in three atomic commits (1,723 lines deleted, build green at every step). Built the recommendation engine in eight commits: pure `recommendEvAction()` translator with 11 tests, signature-based activity-feed dedup (zero schema migration — embedded as a `[helios-sig:…]` marker on the action's `reason` field), full Web Push infrastructure (Service Worker + VAPID + push_subscriptions table + sub/unsub routes + browser helpers + send-side fan-out), 15-min push throttle independent of feed dedup, dashboard banner, Settings notifications card with iOS-aware subscribe flow, integration-row "why read-only" callouts.

**Day 7 (May 1, evening):** Manual end-to-end verification on iPhone PWA. Push round-trip: server → push service → device → Service Worker → notification → tap → Rivian app via `rivian://` deep link. **Worked first try.** Followed up with eight commits of polish: hydration-error fix on dashboard, DB Date-parameter bug squashed, six-card skeleton loading state replacing the blank "loading…" wallpaper, Activity page reordered (chart above feed), tap-to-reveal tooltips on the bar chart with always-above-the-bar positioning and global tap-out dismiss, gross "Spent" + "Credit" numbers shown next to the headline self-sufficiency %, and a final engine fix that surfaced from observing real behavior — when PW is at 100%, skip the remaining-window budget check and use instantaneous surplus only, with clearer "would drain Powerwall" stop messaging when surplus is below the L2 minimum.

---

## Technologies (everything I touched)

### Languages, runtimes, frameworks
- **TypeScript** (strict mode) — one language end-to-end
- **React 19** + **Next.js 16** App Router — same repo for UI and API routes
- **Node.js** (Vercel functions, GitHub Actions cron)
- **Python 3.13** + `bleak` — for the v6 BLE feasibility spike

### Data
- **Postgres** (Neon) with **Drizzle ORM** — typed schemas, raw SQL when needed
- **13 SQL migrations** over the project lifecycle, all hand-rolled, all reversible
- **SWR** — client-side caching with PWA-aware revalidation

### Cloud / hosting / scheduling
- **Vercel** — code deploys, function hosting, cron triggers via `vercel.json`
- **Neon** — managed Postgres with connection pooling
- **GitHub Actions** — supplementary cron for tasks Vercel can't handle natively

### Auth + identity
- **OAuth 2.0** for Tesla, Enphase, Smartcar — three different flavors, three different gotchas
- **M2M token + custom header pattern** for Smartcar V3 — discovered mid-session, replaced the OAuth code-exchange entirely
- **Reverse-engineered GraphQL** for Rivian (CSRF mutation → login → email-OTP → user-session token, three custom headers per call)
- **VAPID keypair signing** for Web Push (W3C standard)
- **Cookie + cron-secret + signed-key triple** for admin gating

### Vendor APIs
- **Tesla Fleet API** — Powerwall site_info + live_status + setBackupReserve, EV-side reads off the Universal Wall Connector
- **Enphase Enlighten v4** — OAuth, consumption + production meters, Watt-plan rate limit aware
- **Rivian unofficial GraphQL** — vehicleState + currentUser + setChargingSchedules + sendVehicleCommand (built end-to-end before discovering the BLE pairing wall)
- **Smartcar V3** — `/v3/connections`, `/v3/vehicles/{id}/signals` (bulk signals API with stale-but-cached pattern), `/v3/vehicles/{id}/commands/charge/{start,stop,set-limit}` (path discovery via empirical probing)
- **Open-Meteo** — keyless forecast, hourly + daily aggregates

### Crypto / signing
- **ECDH on SECP256R1 (P-256)** — built but later reverted; the algorithm is correct, the gate is hardware-pairing
- **HKDF + HMAC-SHA256** — for command-signing
- **VAPID** for Web Push signature

### PWA / mobile
- **Service Worker** at `public/sw.js` — push events, notification click handling, deep-link routing
- **`pushManager.subscribe()`** flow with iOS standalone-PWA detection
- **`rivian://` deep link** for one-tap actuation (verified working on iOS)
- **Apple Web Push → APNs bridge** for iOS PWAs added to Home Screen

### Quality / discipline
- **Vitest** with 89 unit tests and zero integration-test debt (pure functions tested at the boundary)
- **TypeScript strict mode** + `tsc --noEmit` gate before every commit
- **Conventional commit prefixes** (`feat:`, `fix:`, `refactor:`, `revert:`, `docs:`, `chore:`)
- **Three postmortems** in `docs/postmortems/`, each with timeline + root cause + lesson + tactical fix + structural follow-up
- **Memory files** in `~/.claude/projects/.../memory/` capturing dead-end paths and confirmed constraints, so future sessions don't re-investigate

---

## Quantifying the effort

```
Days, calendar:                                        8
Days, full-bore building:                              7
Sessions, distinct (multi-hour focused stretches):    11
Commits:                                              145
Lines of TypeScript (app/src):                     13,859
Lines of test code:                                 1,635
Unit tests:                                            89
API routes:                                            29
DB migrations:                                         13
Vendor APIs integrated (read):                          5
Vendor APIs integrated (write):                         1 (Tesla Fleet, autonomous)
Vendor API integration paths abandoned with proof:      3 (Rivian commands, Smartcar V3 commands, local BLE)
Production incidents survived:                          2 ($6.73 + $1.30 of avoided-going-forward damage)
Postmortems written:                                    3
Memory files written:                                   7 (project-scoped facts that survive across sessions)
Strategic pivots locked from negative findings:         1 (Option B)
End-to-end push-to-iPhone round-trip latency, verified: <5s
Tests passing on the last commit of the session:    89/89
```

For context: I'm not a software engineer. I've been a senior design leader for 30 years. I write basic HTML/CSS comfortably. I think in systems but I'm still building engineering vocabulary.

What this represents isn't a leap in raw skill. It's a leap in **integration of senior practice with new tooling**:

- The engineering discipline (postmortems, atomic commits, tests-on-every-fix) is borrowed directly from how I run design teams.
- The product discipline (constrain to the actual user, defer multi-tenant, name the tariff regime in the rule comment) is straight VP-of-Design instinct applied to architecture decisions.
- The strategic discipline (when three paths fail, accept the negative result and pivot rather than burn more time) is the same call I make on roadmaps.

The novel work is the *code*, not the *judgment*. AI tools made the syntax tractable; the judgment is what made them produce something that actually ships.

---

## Things I built that I'm proud of

**The decision engine itself.** Pure functions, fully unit-tested. `decideEvCharge` is a multi-gate cascade: plug state → parked-day check (with pre-departure relaxation) → SoC ceiling → past-cutoff branch → PW-state-driven rule selection → minimum-rate gate. Every gate fails loudly with a reasoning chain that surfaces in the activity feed. When I had to fix the engine on the very last day (PW-at-100% bug), the change was a 30-line restructure with a tariff-regime comment and three test updates — because the engine was structured around clean inputs and clean branches.

**The signature-marker dedup pattern.** `[helios-sig:stop:high:soc64]` and `[helios-pushed:<iso>]` markers embedded in the action's `reason` field. Activity feed dedups on signature change; push throttles on push timestamp. Both gates independent, both readable, **zero schema migration**. The kind of move you only make when you understand the trade between "right architecture" and "right architecture for the actual problem at this scale."

**The Web Push infrastructure** end-to-end in a single session. Service Worker. VAPID keypair. Browser-side subscribe flow with iOS standalone-PWA detection (the kind of detail that's invisible until the user is in Safari and the page silently fails). Server-side `sendPushToAll` with stale-subscription cleanup on 410/404. An admin-gated `/api/admin/test-push` route for round-trip verification — kept after bring-up because the next time something breaks, the diagnostic is one curl away.

**The negative-result archive.** Three "we tried X, here's why it doesn't work" memos in persistent memory. The Rivian command API, the Smartcar V3 commands, the local BLE spike. Each one has the empirical evidence (request → response → inferred constraint) and the architectural implication. The next person — or the next AI agent — touching this codebase doesn't waste a day re-walking the same dead-end. *That* is senior practice.

**The skeleton loading state.** The user (me) said "the blank loading screen looks amateurish." I built a six-card silhouette dashboard with a warm-palette diagonal shimmer that respects `prefers-reduced-motion`. The cards are hand-tuned to match their real-card layouts so when data arrives there's no shift, just a swap. ~150 lines for what feels like a fundamentally different product.

**The recommendation tooltip on the Self-Sufficiency chart.** First version flipped the tooltip below the bar when the bar was tall, to "avoid clipping." On mobile this put the tooltip directly under the user's finger — defeating the entire point. Fix: always above, with a 72px reserved zone above the SVG so even a 100% bar's tooltip has room. Plus document-level pointer-down dismiss anywhere outside the chart, because in-chart blank space is a small dismiss target on a phone. The kind of detail you only get from actually using the product on the actual device.

---

## Things that didn't work (and what I learned)

I won't pretend the path was smooth. The honest log:

- **Mock data masqueraded as real for 8 hours overnight.** Phantom values from a Tesla API failure were caught by a `try/catch` that kept the prior mock state and continued. Engine fired a 32A overnight charge schedule against $7700 of phantom solar. ~$6.73 of unintended grid imports. Lesson codified: *never fall back to plausible-looking values; fail loudly to `null` or a typed degraded state.*

- **`stopCharging` was actually creating charge windows.** v3 of the Rivian schedule API used `enabled: true, amperage: 0` thinking "you can charge, at up to 0 amps." The car actually read it as "charge during this window, defer to the wall connector for current" and drew at 48A. Helios was actively configuring the EV to charge at peak. ~$1.30 lost; two manual interventions to stop it.

- **The Rivian command API I built end-to-end can't actually fire commands.** Cloud-side `EnrollPhone` succeeded. HMAC was correct. Cloud returned `success:true`. Car returned `state:4 / responseCode:1047`. Cloud auth is necessary but not sufficient; the car wants a BLE-paired phone-key. Helios runs on Vercel. No Bluetooth.

- **Smartcar V3, the officially-supported alternative, hit the same wall.** `409 DEVICE_PAIRING_REQUIRED`. Same constraint, different protocol. The OEM owns the pairing layer; no cloud API can bypass it.

- **The local BLE workaround discovered an even harder constraint.** A 5-hour Python detour to scan the air for any Rivian Phone Key peripheral found... nothing. Not even the legacy peripheral. Inference: Gen 2 R1S uses Apple Car Key, secure-enclave-bound. Cannot be initiated from any non-Apple-enclave device. *No software architecture solves this for this specific car.*

- **A React hydration error silently shipped to production for days.** The error only surfaced in dev mode with unminified errors; production showed minified `#418` that nothing alerted on. Root cause: the dashboard's `if (isLoading)` / `if (error)` branch ladder rendered different content on server SSR vs client first paint. Fix: a `mounted` sentinel pinning first paint to a single deterministic state.

- **A Postgres Date parameter was failing on every status request and falling back silently to a static curve.** The query lived inside a `try/catch` whose `console.error` log was buried under other dev output. ~100ms per request lost; the engine was using a static home curve instead of the learned one. Caught and fixed only after I started running the dev server locally to debug something else.

- **Default chart period was persisting in localStorage across sessions.** Repeat visitors landed on Year/Month and missed today's pattern. Fix: always default to Day; let the user navigate during their session.

- **Self-Sufficiency tooltip put itself directly under the user's finger.** First implementation flipped the tooltip below tall bars to avoid clipping. Mobile use surfaced the bug. Fix: always above, reserve zone above the SVG, global tap-out dismiss.

Each one of these has a tactical fix shipped, and the ones with structural implications have lessons baked into `AGENTS.md` so future code can't re-introduce them.

---

## Conceptual diagrams

Eight SVG diagrams support the in-room presentation and the long-form article. Index + recommended slide order in [docs/diagrams.md](diagrams.md). Files in [docs/diagrams/](diagrams/).

1. [The home system](diagrams/01-home-system.svg) — the four physical assets and the data flow into Helios
2. [Vendor silos](diagrams/02-vendor-silos.svg) — three vendor apps, none talking to each other
3. [NEM 3.0 asymmetry](diagrams/03-nem3-asymmetry.svg) — the 14× import-vs-export penalty that makes orchestration matter
4. [Architecture](diagrams/04-architecture.svg) — the cron loop's READ → DECIDE → ACT → LOG phases
5. [The OEM pairing wall](diagrams/05-pairing-wall.svg) — three independent paths, all hitting Apple Car Key
6. [Option B notification flow](diagrams/06-option-b-flow.svg) — engine → push → iPhone → Rivian app
7. [Signature dedup + throttle](diagrams/07-signature-throttle.svg) — the 2×2 matrix on signature change × time-since-push
8. [Decision cascade](diagrams/08-decision-cascade.svg) — every gate in `decideEvCharge`, in order

Color palette pulled from the app's design tokens; type stack matches the product. Each SVG is standalone — embed inline, export to PNG for slides, scale freely.

---

## Screenshots

> The screenshot directory is `docs/screenshots/`. The README there enumerates the captures referenced below. The placeholders below match the suggested filenames; replace with the actual image files when ready.

**The dashboard on a 100% self-sufficient day:**

![Dashboard with peak banner — engine recommends stop](screenshots/01-dashboard-100pct.png)

**The peak-rate state with a high-priority recommendation:** car drawing 11.2 kW from a draining Powerwall while solar tapers; engine surfaces *"Stop EV charging now — open Rivian app → Charging → set the limit to 77%, or unplug"* in the dashboard banner.

![Dashboard recommendation banner](screenshots/02-recommendation-banner.png)

**Web Push on the iPhone PWA's lock screen:** notification arrives within 1 minute of the engine's signature change, body shows the live drain context ("Car is currently drawing 11.2 kW"), Helios icon visible.

![iPhone lock-screen push notification](screenshots/03-iphone-push-notification.png)

**Activity page with the chart on top:** Self-Sufficiency by hour today, defaulting to Day view; gross **Spent** + **Credit** dollar numbers next to the headline %; tap-to-reveal tooltip showing the exact percent + kWh for hour 07.

![Activity page with self-sufficiency chart and recommendation feed](screenshots/04-activity-page.png)

**Settings page with the Notifications card:** six-state machine (loading / unsupported / denied / off / on / busy / error) with iOS-aware "Add to Home Screen" copy when the user is in a Safari tab instead of the standalone PWA.

![Settings notifications card](screenshots/05-settings-notifications.png)

**The integration row with read-only callout:** Rivian (via Smartcar) and Rivian (direct) tagged read-only; expandable "Why are the Rivian rows read-only?" explainer captures the Apple Car Key constraint without dragging the user out to a separate doc.

![Integrations card with read-only callout](screenshots/06-integrations-readonly.png)

**Skeleton loading state:** six-card silhouette with warm-palette diagonal shimmer; layout matches the loaded dashboard so there's no shift when data arrives.

![Dashboard skeleton loading](screenshots/07-skeleton-loading.png)

**Live cost card during peak:** $0.58/kWh peak rate visible, Cost Today widget showing daily/week/month accumulation, next transition countdown.

![Cost card during peak hours](screenshots/08-cost-card-peak.png)

---

## What this is, and what it isn't

**This is:** a working production system solving a real problem in one specific home. It saves my family money on every sunny day. It surfaces actionable recommendations on every not-sunny day. It has been live-tested against the actual car, the actual Powerwall, the actual peak-rate clock, and the actual NEM 3.0 meter.

**This is also:** a portfolio-grade case study in senior product judgment under engineering ambiguity. The codebase isn't perfect — there's deferred maintenance documented in `docs/session-handoff.md`, three latent P2 items I've intentionally not addressed yet. The README directory of screenshots is more aspirational than complete. There's a known follow-up to surface caught-but-noisy errors more visibly.

**This is not:** a multi-tenant SaaS product. It's not feature-complete. It doesn't (and can't) actuate the EV — by hardware-level constraint that no software layer can bypass on this specific vehicle.

**This is not:** "the AI did it." Every product decision, every architectural trade-off, every postmortem framing, every commit message, every test boundary, every UX detail (the 72px reserved zone above the chart, the gross-vs-net cost framing, the "would drain Powerwall" stop messaging) was mine. AI tools accelerated the syntax, not the judgment. The strategic moves — refusing to chase Apple Car Key after the BLE spike confirmed it; choosing signature markers over a schema migration; defaulting the chart to Day — those came from 30 years of design leadership applied to a new substrate.

---

## What's next (if I keep going)

| Item | Type |
|---|---|
| Surface caught-but-noisy errors in the data-health badge | P1 quality |
| Cache `/api/recommendation` for 30s server-side | P1 perf |
| Refactor `new Date()`-in-render usages to a shared `useNow()` hook | P2 |
| Move `mockStatus()` out of the production bundle (env-gated) | P2 |
| Surface `oemUpdatedAt` in the source-status plumbing | P2 |
| Stale-subscription cleanup job for push | P2 |
| Extract a reusable `<Tooltip>` / `<Overlay>` primitive | P3 |
| Add `morning_bridge_floor_pct` to Settings UI | P3 |

If the household ever switches the EV to a vehicle with a non-Apple-Car-Key command surface (Tesla Fleet API works for Tesla vehicles, no pairing wall), the actuator layer rewires in roughly a day. The decision engine is provider-agnostic by design.

---

## The top-line

**A senior design leader, beginner coder, shipped a real-time multi-vendor home energy decision engine in 8 days. 145 commits. 5 vendor API integrations. 3 production incidents survived with full postmortems. 1 architectural pivot from a definitive negative result. 89 unit tests, all passing. Powerwall reserve fully autonomous, EV charging surfaced as one-tap recommendations on his iPhone via Web Push. Live, working, used daily by him and his wife. The decision engine is the IP. The pivot was the senior move. The product solves a real problem that no off-the-shelf vendor will solve in the foreseeable future.**

That's the case study.

---

## References

- [docs/postmortems/2026-04-29-mock-data-incident.md](postmortems/2026-04-29-mock-data-incident.md)
- [docs/postmortems/2026-04-30-rivian-schedule-trap.md](postmortems/2026-04-30-rivian-schedule-trap.md)
- [docs/postmortems/2026-05-01-option-b-implementation.md](postmortems/2026-05-01-option-b-implementation.md)
- [docs/session-handoff.md](session-handoff.md)
- [docs/case-study-v1-5day-snapshot.md](case-study-v1-5day-snapshot.md) — the version of this case study at the 5-day mark, before the Option B pivot and Web Push work landed. Kept as a historical artifact of how the story changed.

*Last updated: 2026-05-01.*
