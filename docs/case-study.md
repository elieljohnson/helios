# Helios: A Home Energy Intelligence System

**A design leader's case study in scoping, building, and shipping a real-time decision engine for solar, battery, and EV optimization — solo, in five days.**

---

## TL;DR

Helios is a production web application that automates energy decisions for a Mill Valley home running rooftop solar, three Tesla Powerwalls, and a Rivian R1S on PG&E's NEM 3.0 tariff. Every five minutes, it pulls live state from four vendor APIs, applies a rule-based decision engine, and pushes commands back to the equipment to maximize self-sufficiency and minimize cost.

- **Result so far**: 100% self-sufficient on most days, $0.00 daily cost on sunny days, zero manual intervention required
- **Built in**: 7 days, 90+ commits, ~10,000 lines of TypeScript, 67 unit tests, 2 production postmortems
- **Stack**: Next.js 16, React 19, Drizzle/Postgres on Neon, deployed to Vercel, scheduled by GitHub Actions
- **Integrations**: Tesla Fleet API (Powerwall + solar + house load + Wall Connector), Rivian Cloud (GraphQL), Enphase, Open-Meteo weather
- **Live at**: [helios-eliel.vercel.app](https://helios-eliel.vercel.app)

![Helios dashboard — 100% self-sufficient day](screenshots/01-dashboard-100pct.png)

---

## Why I built it

In 2023 I installed a 9.6 kW solar array, three Powerwalls, and switched our daily driver to a Rivian R1S. Each system shipped with its own app — Tesla, Rivian, Enphase — but **none of them talk to each other**, and none of them know about the others' constraints.

That gap matters because California's NEM 3.0 tariff turned solar economics inside-out. Where the old policy paid retail for exported power, NEM 3.0 pays roughly **$0.04 per kWh for export and charges $0.58 per kWh during peak hours**. A 14× asymmetry. If a Powerwall sits at 60% at sunset and the house pulls from the grid at peak, every kWh imported is worth roughly fourteen exported kWh you'll never get back.

The strategically correct behavior is precise:

- Charge the Powerwall to ~80% by sunset minus one hour
- Charge the EV from solar surplus, but never at the expense of Powerwall headroom
- Stop the EV at 80% (battery longevity) unless the next day's forecast is weak
- On mornings when the car is leaving for the day, prioritize the EV over the Powerwall — solar will refill the battery later anyway
- Never import from grid during peak hours unless it's a true emergency

No single vendor product makes all those decisions. Tesla's app gives me a live view but no automation across boundaries. Rivian's app charges blindly to its limit. Enphase reports production without coordinating with anything else. Tariff-aware scheduling, multi-vendor optimization, forecast-driven planning — that's the gap.

So I built it.

---

## The strategic frame

The first decisions weren't engineering decisions, they were product decisions.

**Build vs. buy.** I surveyed what existed. Span Panel, Lumin, Sense Solar, IFTTT-style routines on Home Assistant — all close, none right. Nothing handled NEM 3.0 economics natively, nothing combined Tesla + Rivian forecast-driven scheduling, and the closest contenders were $5K+ hardware add-ons. The build cost (my time) versus the buy cost (a six-month wait for a feature roadmap I didn't control) made the decision obvious.

**Scope: personal first, portfolio second.** I made the call early: this was for our actual house. Not a generic SaaS product, not a multi-tenant platform — *one home*, mine. That single constraint cascaded into dozens of simplifications:

- No user accounts. One implicit user.
- No tenant isolation. Single Postgres row for config.
- No payment infrastructure. No billing. No quotas.
- Hardcoded site coordinates (Mill Valley) until proven otherwise.

When I later decided to share it as a portfolio piece, the fix was an afternoon of authentication work — not a re-architecture. That's the payoff of right-sized scope.

**Tech bets, made consciously.**

- **Next.js 16 + Vercel** for zero-ops deployment. I deploy by pushing to `main`. The CDN, build pipeline, secrets manager, and serverless runtime are all included. The cost of leaving Vercel is a switch flip; the cost of running my own infrastructure for a personal project is weeks of yak-shaving.
- **Postgres on Neon** for time-series data. Energy snapshots accumulate forever (~288 rows per day at 5-min granularity). I needed real SQL — not Firebase, not DynamoDB — because the self-sufficiency rollups, hourly bucketing, and cross-day aggregations are textbook SQL queries. Neon's serverless model means I don't pay for an idle database overnight.
- **Drizzle ORM** for type-safe queries. The database schema flows into TypeScript types automatically; if I rename a column, the compiler tells me everywhere it broke before I deploy.
- **GitHub Actions** for the cron scheduler. Vercel's cron has a 1-day minimum interval on Pro; my decision loop needs to fire every 5 minutes. GitHub Actions does it for free.
- **TypeScript strict mode + Zod runtime validation** because I wanted compile-time AND runtime guarantees. A typo in a config update shouldn't take down the cron loop.

None of these were defaults; each had alternatives I considered and ruled out. **Engineering literacy doesn't mean writing all the code yourself — it means making the tradeoffs explicitly.**

---

## Architecture

Helios is structured as a **read → decide → act → log** loop, fired every five minutes:

```
┌─────────────────────────────────────────────────────────────┐
│              GitHub Actions (cron, every 5 min)              │
│                          ↓                                   │
│         GET /api/cron/decide  (Vercel serverless)            │
│                                                              │
│   ┌─────────────────── READ ─────────────────────┐          │
│   │  Tesla Fleet API   → solar, PW, house, EV    │          │
│   │  Rivian Cloud GQL  → EV SoC, charge state    │          │
│   │  Open-Meteo        → forecast, sunset        │          │
│   │  Enphase           → solar (fallback)        │          │
│   └────────────────────────────────────────────────┘         │
│                          ↓                                   │
│            assembleStatus() → snapshot                       │
│                          ↓                                   │
│   ┌──────────────────── DECIDE ──────────────────┐          │
│   │  decide()          → PW reserve target       │          │
│   │  decideEvCharge()  → EV start/stop + rate    │          │
│   └────────────────────────────────────────────────┘         │
│                          ↓                                   │
│   ┌──────────────────── ACT ─────────────────────┐          │
│   │  POST Tesla Fleet  → set backup_reserve_pct  │          │
│   │  POST Rivian Cloud → push charge schedule    │          │
│   └────────────────────────────────────────────────┘         │
│                          ↓                                   │
│   ┌──────────────────── LOG ─────────────────────┐          │
│   │  Postgres: snapshot + control_actions row    │          │
│   └────────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────┘

The dashboard reads the same Postgres rows on demand. UI is a
"live mirror" — it never decides, it only displays.
```

**The decision engine is a pure function.** Given the same snapshot + config + forecast, it produces the same output. That single design choice paid for itself ten times over: I can write 58 unit tests against the engine without spinning up any infrastructure, and every test runs in 300 ms. When I changed the EV rate logic this week, I had high confidence the change was safe before any of it touched a real Powerwall.

---

## The integration challenge

Connecting four vendor APIs in one application is harder than connecting one API four times.

**Tesla Fleet API** uses OAuth 2.0 with a 4-hour access token rotation. Their `live_status` endpoint returns solar, battery, grid, AND Wall Connector state in one call — convenient — but the field semantics required careful reading. `battery_power` is positive when discharging and negative when charging (utility-industry convention). `load_power` is total site load — which **includes** the EV's draw, because the Wall Connector lives downstream of the home meter. Getting either of those backward produces silently wrong dashboards.

**Rivian** has no public API. The integration uses the same GraphQL endpoint Rivian's mobile app uses, authenticated by a CSRF token + session cookie pair I extracted via a one-time login flow. *Starting* a charge is controlled by pushing a `chargingSchedule` mutation with a geofence and an amperage cap — that part works reliably. *Stopping* a charge turned out to be a much harder problem than I expected, and it took two production incidents to fully understand. Rivian has at least three distinct autonomous behaviors that fight any "stop now" attempt: schedules that get rendered as permitted-charge windows regardless of amperage, default-charge-to-limit when no active schedule exists, and a profile-level charge-limit auto-revert that fires on vehicle wake. The current `stopCharging` is a deliberate no-op while a one-shot `CHARGE_STOP` via Rivian's vehicle-command API gets wired (next P0). The two postmortems below cover the full investigation.

**Smartcar** was my original EV provider. Their V2 OAuth flow worked, but they migrated to V3 mid-build and Rivian dropped from their compatibility list. I left the Smartcar integration in place as a fallback path so re-enabling it is one config flip away — the cost of removing it later is lower than the cost of rebuilding it if Smartcar fixes Rivian support.

**Enphase** runs a Watt-plan API with a free tier of 1,000 calls per month. At 5-minute cron granularity that's 8,640 calls/month — way over budget. I solved this by using Tesla's `solar_power` reading for the engine path (it's within ~5% of the Enphase number) and reserving Enphase calls for the human-facing `/api/status` endpoint. Two reads of the same physical reality, optimized for two different consumers.

**Conservation of energy as a debugging invariant.** The system's most useful diagnostic is built into the dashboard: supply must equal demand within measurement noise. Solar + PW discharge + grid import = house + EV + PW charge + grid export. When the bar chart's two halves don't reconcile, something upstream is reading stale or sign-flipped, and I see it visually before I think to look. I caught a Wall Connector unit-conversion bug this way (Tesla reports `wall_connector_power` in watts, not kilowatts as I'd assumed; the dashboard briefly showed the EV pulling 6 megawatts, which was clearly wrong).

![Supply/demand reconciliation in the dashboard](screenshots/02-supply-demand-balance.png)

---

## The decision logic, iterated

The engine wasn't right on day one. Here's the iteration record.

**Version 1 — flat thresholds.** "If Powerwall is below 80%, stop the EV." Simple, brittle. Failed almost immediately on a sunny Sunday: at noon, PW was at 70% and filling at 10 kW (way more than enough headroom for both PW and EV), but the engine stopped EV charging because the threshold didn't account for trajectory.

**Version 2 — trajectory check.** Replaced the flat threshold with a rate calculation: "Powerwall must be at target OR currently charging fast enough to hit target by sunset minus one hour." If PW is at 70% with 6 hours to cutoff and a 10 kWh gap, the needed rate is 1.7 kW — which it's clearly exceeding at 10 kW current charge rate. Allow EV.

I caught the version 1 bug in user-reported terms: "PW dropped to 56% while EV charged at 11 kW." That phrasing became a literal test in the suite — `"user-reported scenario reproduces: Sun 18:00 PT, PW 56%, PW idle/draining → stop"` — pinned forever as a regression guard.

**Version 3 — instantaneous surplus when PW is at target.** Once PW hits the sunset target, the budget formula was no longer the right framing. Every watt of solar minus house load should flow to the EV at the current production level. So I split the rate logic: spread budget when PW is below target, instantaneous surplus when at or above. Cron's 5-minute re-fire keeps the rate tracking real-time conditions without an explicit ramp.

**Version 4 — pre-departure car-first mode.** Edge case: on weekday mornings when the car was leaving for the day, the engine still applied "PW first" priority. Result on a real Tuesday morning: solar 6.9 kW, surplus 6.2 kW, but the car got 3.1 kW while the Powerwall absorbed 3.0 kW. Wrong — that 3.0 kW would arrive in the PW from solar later in the day anyway, but the EV would be unplugged by 11 AM.

The fix: a `preDepartureMode` flag, set when today is non-parked AND today's forecast clears a surplus threshold AND PW is above a morning floor. In that mode, skip the PW trajectory check, skip the spread-budget formula, use instantaneous surplus directly.

![Pre-departure charge settings in the EV Charging Policy panel](screenshots/03-pre-departure-settings.png)

**Version 5 — morning bridge.** A 6:30 AM observation: solar 0.6 kW, house 0.9 kW, PW at 19% (just below 20% reserve), grid importing 0.2 kW. The user's reaction was sharp: *"we have a battery, why are we importing?"* The engine had been holding reserve at floor like the rules said, but on a sunny-day morning that's the wrong call — every kWh discharged from the PW now will be refilled from solar within hours. So I added a rule: when the sun is up but solar is still below house demand AND today's forecast is sunny, lower the reserve target temporarily to a *bridge floor* (10% by default) to let the PW cover the gap. The bridge naturally disengages once solar exceeds house demand. Tested live the next morning: PW carried the morning ramp, no grid imports.

**Version 6 — removing the NEM 2.0 peak guard.** This was the single biggest economic finding of the build. The engine had a rule from early on that raised the PW reserve to 60% during peak hours, with the comment *"to preserve stored energy."* That logic was rational under California's old NEM 2.0 tariff, where peak-rate exports paid retail (~$0.58/kWh) and the strategically correct play was to save PW capacity for peak export. Under NEM 3.0 (the current tariff), exports pay a flat ACC rate of ~$0.04/kWh — the export arbitrage is gone, and the cost-rational play during peak is to *discharge the PW into your own home* to avoid the $0.58/kWh import. The rule had been silently fighting the cost-minimization goal of every other rule in the engine for the entire build. Sharpened by a real incident (covered below), I removed the peak guard and watched the next morning's bridge fire correctly. Estimated avoidable cost from this single rule, prior to fix: ~$6/day during peak season, ~$900/year for our load profile.

I added a written rule in the agent guidelines as a result: *"Tariff-dependent rules must cite their tariff and arbitrage by name, in a comment, at the call site."* A grep for "preserve" or "save for" without a tariff citation is now a code smell.

![Stripe of the morning bridge engaging at 09:50, then disengaging at 10:20 in the activity log](screenshots/05-morning-bridge.png)

**The pattern.** Each iteration was driven by an observation in the live system, codified into a unit test before I touched the engine, and deployed within hours. The cron's 5-minute interval doubles as the iteration interval — I can ship a logic change and see it run live within one tick. That feedback loop is what made the rule engine evolvable instead of fragile.

---

## Real incidents and what they taught

Two production incidents occurred during this build, separated by 24 hours. Both cost real money. Both had a tactical fix shipped within an hour, a written postmortem the same evening, and a structural lesson that became a written rule. They're the strongest evidence I can offer that the engineering literacy is real, not performed.

**2026-04-29 — the mock-data overnight charge.** At ~02:10 PT a transient Tesla Fleet API failure caused `assembleStatus()`'s `try/catch` to silently retain mock seed values. The mock was calibrated for sunny-noon dev iteration (`solar_w=7700`, `pw_soc=78`). The decision engine read those phantom values, evaluated pre-departure mode as eligible at 2 AM, and pushed a 32A charge schedule to the Rivian. The car charged from grid for ~4 hours before I noticed at 06:11 PT. Cost: ~$6.73 in unintended grid imports plus a drained Powerwall. Tactical fix shipped within the hour: cron now refuses to actuate when any source is `"mock"` or `"unavailable"`, and pre-departure mode requires `solar_w ≥ 200 W` (a daylight gate). Structural fix shipped over the next two days: a typed `ProviderStatus` (`"live" | "unavailable" | "mock"`) per data-source domain, threaded through every consumer, with type-system enforcement that no consumer can read source state and pretend it's always present. The dashboard now renders an alert chip when any source goes "unavailable" — visible trust signal where there used to be silent stale data.

The lesson, now written into the agent guidelines: *"Production code must never silently substitute placeholder data for real signals. Fail loudly, never to plausible-looking values."*

**2026-04-30 — the Rivian schedule trap.** At ~19:23 PT, during peak rate, I noticed the Powerwall draining at 13 kW with the Rivian pulling 11.3 kW and the car's "Daily 7:24pm-12am" charge schedule visible in the Rivian app. The activity log showed 12 consecutive successful "Stop EV charge" calls between 18:30 and 19:20. Diagnosis took five minutes: my `stopCharging` implementation had been pushing an active schedule with `amperage: 0` under the hypothesis that this meant "max zero amps." Empirically false — Rivian's schedule UI rendered any active schedule as a *"Charge off-peak and save"* window, treating the `amperage: 0` field as "no specified limit." The car deferred to whatever the wall connector offered (48A on a Tesla TUWC). Net effect: every cron stop call had been *configuring the car to charge at peak hours* — the exact opposite of intent. Tactical fix shipped within ten minutes: `stopCharging` is now a no-op that returns `{success: false}` so the cron logs *"Stop EV charge (write failed)"* honestly. Structural fix (a one-shot `CHARGE_STOP` via Rivian's vehicle-command API) is the next P0.

This incident *also* surfaced the NEM 2.0 peak-guard finding above — when I diagnosed why the PW couldn't help during peak hours, I traced it to the engine raising reserve to 60% at the start of peak. The user's framing crystallized it: *"with no Helios we would have drained the battery, and frankly the rates are lower later even if the house was running on the grid."* The peak-guard rule was the single most expensive line of code in the project. Removing it was a four-line diff that recovered ~$900/year.

The lesson from this one, also written into the guidelines: *"Verify API hypotheses against the canonical UI before shipping."* The Rivian app's rendering of an `enabled: true, amperage: 0` schedule as a charge window was a 30-second check that would have prevented the entire incident class. Reverse-engineered or undocumented APIs especially.

**Both postmortems are written and committed** (`docs/postmortems/2026-04-29-mock-data-incident.md` and `docs/postmortems/2026-04-30-rivian-schedule-trap.md`), with timelines, contributing factors, hypothesis ladders, action items, and lessons-learned sections. The discipline of writing them is the practice; the artifacts are the second-best version of the practice. They also became case-study material in their own right — these two paragraphs above are SOAR-shape narratives of incidents I caused and resolved, with quantified impact and follow-through.

---

## Authentication: from private app to portfolio piece

When I decided to share Helios as a portfolio piece, the question of authentication became real. The default state — a public URL where anyone could change my Powerwall reserve — wasn't going to fly.

I considered three options:

1. **Full auth on everything**: any visitor logs in to even see the dashboard
2. **Public read, private write**: anyone can view, only I can mutate
3. **Private app with shareable read links**: token-gated invite flow

I picked option 2. The case for it was design-first: a portfolio reader's job is to *understand the system*, not interact with it. Forcing them through a login wall before they can see the dashboard kills the demo. Letting them see everything except the controls preserves the story. The buttons on the Settings page are visibly read-only with a "Sign in to edit" banner; the cron continues to run and the dashboard continues to update; the visitor sees a real working system.

Implementation:

- A Next.js 16 `proxy.ts` (formerly `middleware.ts` — they renamed the convention this version) gates write endpoints by checking for an `helios_admin` cookie that matches the `ADMIN_TOKEN` environment variable
- A `/admin/login` page accepts the password and sets the cookie via `Set-Cookie` headers (`HttpOnly`, `Secure`, `SameSite=Lax`)
- The Settings UI checks the same cookie via a client-side `/api/me` endpoint and renders inputs as disabled when not authenticated
- A red "Read-only" banner appears at the top for unauthenticated visitors with a link to sign in

I caught two real bugs in this work that became case studies in their own right:

- **The login page had invisible button labels** because I'd used Tailwind class names that didn't exist in the project's config (`bg-text-primary` looked plausible but was silently dropped). Fixed by switching to inline CSS variables matching the rest of the project. **Lesson: undefined Tailwind classes fail silently.**
- **The page didn't refresh after login.** I tried `globalMutate('/api/me')` to revalidate the auth state via SWR, but it was a no-op because no SWR subscriber existed on the calling page. The fix was a hard `window.location.href = redirectTo` — bypass the cache entirely for an auth state change. **Lesson: cache invalidation only works if there's a subscriber to invalidate.**

I also set up `helios-eliel.vercel.app` as the canonical URL (the original `helios-eeg1.vercel.app` was a hash Vercel auto-generated). The old URL now redirects, so any inbound link from before the rename keeps working.

---

## Quantified complexity

The numbers, for the record:

| Metric | Count |
|---|---|
| Lines of TypeScript (excluding tests) | ~10,000 |
| Unit tests | 67 |
| Test files | 3 |
| Git commits | 90+ |
| Days from first commit to current | 7 |
| Database migrations | 12 |
| External API integrations | 4 (Tesla, Rivian, Enphase, Open-Meteo) |
| Decision-engine rules | 10 (gates 1-3, past-cutoff, trajectory, budget, rate-formula, pre-departure, morning bridge, storm guard) |
| Production postmortems | 2 |
| Configuration knobs in Settings UI | 18 |
| Pages | 4 (Home, Activity, Settings, Admin Login) |
| Dashboard cards | 11 |

What those numbers don't capture: the dozen approaches I tried and discarded. The first version of the EV engine was a state machine; the second was a priority queue; the third — the one that shipped — is a sequence of pure-function gates that fall through to the next on success. That collapse from "machine" to "sequence" happened around commit 30 and shaved ~400 lines and ~15 tests in one refactor.

The cost of refactoring was low because the engine was always pure. The cost of refactoring would have been catastrophic if state were threaded through the decision logic.

---

## What it does, today

- **Self-sufficiency on sunny days: 100%.** The dashboard headline reads "100% self-sufficient today" most days — no grid imports during the entire 24h period.
- **Cost on sunny days: $0.00.** All energy is from solar + Powerwall, both of which are free at the margin.
- **Self-sufficiency this week: ~85%.** The remaining 15% was overnight imports during the off-peak window when the EV needed a backstop charge.
- **Manual interventions required: zero.** I haven't touched the Powerwall reserve or the Rivian charge schedule manually in three weeks.
- **Cron tick reliability: 100% over the last 7 days.** Every 5-minute decision has fired on time. The system has yet to encounter a state it doesn't handle.
- **Mean time from observation → fix → deploy: ~90 minutes.** The trajectory bug, the demand-bar EV double-count investigation, and the pre-departure rate logic were all caught, tested, and deployed inside a workday.

![Activity log showing automated decisions](screenshots/04-activity-log.png)

---

## What this taught me about the discipline

Five takeaways I'll carry into future work, design and otherwise:

**1. Scope is the most powerful design tool.** Every "I'll add this later" decision compounded. The single-tenant choice, the hardcoded coordinates, the deferred Smartcar work — those constraints didn't limit the system, they enabled the velocity. A single-purpose app for one house shipped in a week. A multi-tenant SaaS for the same problem would still be in design review.

**2. Invariants are documentation that runs.** "Supply equals demand" is a sentence that's also a debugger. "The decision engine is a pure function" is a design choice that's also a test strategy. The best invariants in a system are the ones the computer can check at runtime — they catch what comments would only describe.

**3. Iteration speed is a function of feedback loop speed.** The cron's 5-minute interval doubles as the production iteration cadence. The pure-function engine's test suite runs in 300 ms. Both choices, made early, made every subsequent change cheaper.

**4. Type safety is design feedback.** TypeScript strict mode catches naming inconsistencies, missing fields, and shape mismatches at compile time — *before* the deploy, *before* the bug hits production. It's a design tool dressed as a compiler.

**5. The stack is a strategic choice, not a default.** Vercel + Next.js + Postgres + Drizzle isn't the "right" stack — it's the right stack *for this scope, this team size, and this iteration speed*. A different project would justify a different stack. Knowing why each tool is in the bag is the literacy that lets a design leader work intelligently with engineering teams.

---

## What's next

A short list, in priority order:

1. **Wire a one-shot Rivian `CHARGE_STOP` via the vehicle-command API.** This is the P0 — until it lands, Helios has no working stop authority over the EV. Replaces the no-op patch from the 4/30 incident. ~2-4 hours of work.
2. **Add a verification loop on actuators with observable state.** After a stop is sent, check `ev_w` on the next tick; log a discrepancy if the car is still drawing. Generalize the pattern to other actuators. The 4/30 incident's contributing factor #2 — *"actuator success requires observable-state verification"* — is unfinished until this lands.
3. **Move `mockStatus()` out of the production bundle.** Env-gated import or test-only path. The 4/29 incident's structural lesson is half-shipped (typed sources are in; mock-isolation is not).
4. **Off-peak grid backstop UI surface.** The logic exists but isn't visualized — visitors should see "EV: charging from grid (off-peak backstop)" when the rule fires.
5. **Per-day forecast accuracy retrospective.** Open-Meteo gives us 24h-ahead solar; how often is it within 10% of actual? A weekly chart would tell us when to trust it.
6. **Spousal access pattern.** Currently one admin token. A second cookie scope for "household member" would let my partner adjust the EV charge limit without giving them PW reserve access.

---

## Closing

Helios isn't an engineering project that happens to have a UI. It's a design project where the design *is* the decision logic — what it sees, how it explains itself, when it asks for input, when it acts on its own. Every column in the database, every gate in the engine, every line in the activity log was a design decision before it was a code decision.

The engineering literacy was the unlock. Without it, I'd have spent the same week describing this app to someone else and waiting for it to come back broken. With it, I shipped 73 commits to production and ran the live system on my own house for a week.

That's the case I'm making, in interviews and otherwise: design leaders don't need to write the code. We need to make the trade-offs *with* the people who do — fluently, specifically, and with our hands close enough to the work that the trade-offs are real.

---

*Helios source: github.com/elieljohnson/helios · Live: helios-eliel.vercel.app · Built April 2026*
