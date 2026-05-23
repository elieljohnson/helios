# Helios — one-page email version

*A senior design leader's case study. Built in 8 days. Running in production for 26.*

---

**The problem.** Our Mill Valley home runs a 16.1 kW DC Enphase solar array (35× REC 460W panels with IQ8X-80 micro-inverters; AC output clips at exactly 13.3 kW by design, year-one estimate 21,660 kWh, 154% offset), 40.5 kWh of Tesla Powerwall 3 storage on a full-house backup config, and a 2025 Rivian R1S on PG&E's NEM 3.0 tariff. Every system has its own app. None talk to each other. NEM 3.0 made the economics asymmetric — a 14× penalty for getting the orchestration wrong on every peak-hour kWh. No off-the-shelf product solves it. So I built the one we needed.

**What it does.** Every five minutes, Helios pulls live state from five vendor APIs, runs a tariff-aware decision engine, autonomously manages the Powerwall reserve, and sends a Web Push notification to my iPhone *exactly when* the EV needs attention — with a one-tap deep link into the Rivian app. On sunny days the system runs silently and our daily cost rounds to zero. On not-sunny days my phone tells me what to do.

**The hero's journey, in one paragraph.** I'm a senior design leader, 30 years in, beginner coder. I scoped the product to one specific home (mine), built the data layer + decision engine + UI in 5 days, then ran into the wall every product runs into eventually: the most strategically important automation — *stop the EV at the right moment* — required a hardware-level pairing credential bound to a specific Apple iPhone's Secure Enclave. I learned this only by trying three independent paths and running each to empirical failure: Rivian's unofficial command API, Smartcar's officially-supported V3 commands, and a local Bluetooth daemon. Three negative results. Each one carefully documented. Then I made the senior move: instead of building a $200 Raspberry Pi BLE proxy that would have taken another two weeks and added permanent infrastructure debt, I pivoted the architecture to "decision engine + manual-action UX with Web Push." Built that in one focused session. Verified the full server → push service → iPhone → Rivian app round-trip on my own device. Shipped. **Then ran it in production for 19 days** — four more incidents in the first eight of those, each with a postmortem the same day and a tactical fix in the hour. Two new decision-engine gates landed during this period. The system is more honest about its own state now than it was at launch.

**By the numbers.**

| | |
|---|---|
| Calendar days | 26 (8 to launch, 19 in production) |
| Commits | 201 |
| Lines of TypeScript (app code) | ~16,000 |
| Unit tests | 161, all passing |
| Vendor APIs integrated | 5 (Tesla Fleet, Enphase v4, Rivian GraphQL, Smartcar V3, Open-Meteo) |
| API routes | 30+ |
| Database migrations | 18 |
| Production incidents survived (with postmortems) | 7 |
| Decision-engine gates added post-launch | 2 (Gate 1d alarm, Gate 2.5 limit-raise) |
| Strategic pivots from a definitive negative finding | 1 |
| Live at | helios-eliel.vercel.app |

**Stack.** Next.js 16 App Router, React 19, TypeScript strict, Drizzle ORM + Neon Postgres, SWR, Tailwind v4. Deployed to Vercel with cron triggers via `vercel.json`. Web Push via W3C standard (Service Worker + VAPID keypair) with Apple's iOS bridge. Three OAuth flows, one M2M-token-plus-custom-header pattern, one reverse-engineered GraphQL gateway. ECDH/HKDF/HMAC-SHA256 crypto built end-to-end before being shelved when the BLE pairing wall surfaced (the algorithms work; the gate is hardware).

**What I'm proud of, honestly.**

- The decision engine is a *pure function* with full unit-test coverage. When I had to fix it on the very last day after observing real behavior, the change was 30 lines, with the tariff regime named in the comment so a future maintainer can't miss the assumption.
- The signature-marker pattern that gives me activity-feed dedup *without a schema migration* — `[helios-sig:…]` embedded in the action's `reason` field, stripped at the API edge. The kind of trade-off you only make when you've already understood the architecturally correct version.
- Multiple "we tried this, here's why it doesn't work" memos in persistent memory, so the next person — or the next AI agent — doesn't waste a day re-walking the dead ends I closed.
- The skeleton loading state. ~150 lines for what feels like a fundamentally different product. The user (me, on a phone, on cellular) said "the blank loading screen looks amateurish." So I built six hand-tuned card silhouettes that match the loaded layout exactly.
- **Gate 1d, earned through two real incidents.** First version alarmed on grid-imports-at-floor when the EV was also drawing. Day 14's Rivian outage corrupted the EV-side data, the alarm couldn't see the car, and the bill went up $3.11 overnight. Broadened it to fire on grid imports independent of EV-side signals. The kind of alarm that earns its keep across every failure mode of the systems it's watching.
- **The drag-to-scrub on the history chart**, lifted from Rauno Freiberg's craft and adapted for discrete buckets. Pointer Events with `setPointerCapture`, `touch-action: none` on the overlay, 4px tap-vs-drag dead zone, outside-tap dismiss scoped to the SVG (a bug I shipped + caught + fixed in 10 minutes). Documented as a portable spec so the pattern can be lifted into other projects.

**Why it matters for a design leader's portfolio.** This isn't a coding case study. It's a senior-judgment case study expressed in a new substrate. The engineering practice (postmortems, atomic commits, regression tests on every fix) is borrowed directly from how I run design teams. The product practice (constrain to the actual user, defer multi-tenant, name the tariff regime in the rule comment, fail loudly never to plausible-looking values) is straight VP-of-Design instinct applied to architecture decisions. The strategic practice (when three paths empirically fail, accept the negative result and pivot rather than burn more time) is the same call I make on roadmaps. The novel work was the *code*. The judgment is the same judgment I bring to every design organization I've led.

It also solves a real problem for a real family — mine.

**Live at:** [helios-eliel.vercel.app](https://helios-eliel.vercel.app)
**Source + docs:** github.com/elieljohnson/helios — including seven production postmortems in `docs/postmortems/` and a portable interaction spec at `docs/drag-to-scrub-pattern.md`.

---

*If this kind of judgment-under-ambiguity, integration-of-senior-practice-with-new-tooling profile is interesting for your team, I'd love to talk.*
