# Helios — quick summary + top-line story

*A reference for "what is this thing actually about" when you have 60 seconds, 5 minutes, or want the full case study.*

---

## The 60-second version

A senior design leader (30 years, beginner coder) shipped a real-time multi-vendor home energy decision engine for his own house — 16.1 kW DC solar (clips at 13.3 kW AC by design), 40.5 kWh Powerwall 3 storage on a full-house backup, Rivian R1S on a Tesla Wall Connector — in 8 days. **Has run it in production for 19 days since.** 201 commits total, 5 vendor APIs, 161 unit tests, 7 production postmortems, 1 architectural pivot from a hardware-level dead-end, 2 new decision-engine gates added post-launch to harden against real failure modes. The Powerwall reserve is autonomously managed; EV recommendations land on his iPhone via Web Push with one-tap deep links into the Rivian app. Live, working, used daily by him and his wife.

Live at: [helios-eliel.vercel.app](https://helios-eliel.vercel.app)

---

## The top-line story (the real headline)

**This isn't a "designer learns to code" story. It's a senior judgment case study expressed in a new substrate.**

The novel work is the code. The judgment — postmortems on every incident, regression tests on every fix, atomic commits with conventional prefixes, "constrain ruthlessly to the actual user" product instincts, "when three paths fail, pivot rather than burn more time" strategic instincts, naming the tariff regime in the rule comment so it can't get forgotten — is the same judgment a senior design leader brings to every organization they've led. AI tools accelerated the syntax. They didn't accelerate the judgment. The judgment is what made the syntax produce something that actually ships.

The single most senior moment in the project: ~Day 7, after building the Rivian command API end-to-end (4 commits, 11 unit tests, ~700 lines of crypto + auth + wrapper code) and discovering at live test that it can't actually fire commands because cloud-auth is necessary-but-not-sufficient — the car wants a BLE-paired phone-key. Rather than build a $200 Pi-on-the-home-network workaround that would have added permanent infrastructure debt, I pivoted the entire product architecture to "decision engine + manual-action UX with Web Push." Three commits to revert the dead path. Eight commits to build the new one. Verified end-to-end on my own iPhone the same day.

That's the story.

---

## Highlights of the larger story

**The problem.** NEM 3.0 broke the old economics. Imports cost up to $0.58/kWh; exports earn ~$0.04/kWh. A 14× asymmetry. No vendor product makes coordinated decisions across solar + Powerwall + EV with NEM 3.0 economics + forecast-driven scheduling. Span Panel ($5K), Lumin ($3.5K), Sense, Home Assistant — all close, none right. Build cost (my time) versus buy cost (six months waiting for someone else's roadmap) made the call.

**The product scope.** One home. Mine. No multi-tenant. No accounts. No analytics. Single Postgres row for config. The "admin" is a shared cookie. This is a senior PM move — defer the platform problem until you have a platform — and it freed up a week of real engineering on the actual decision logic.

**The stack.** Next.js 16 App Router on Vercel. Drizzle + Neon Postgres. SWR for client state. Tailwind v4. Vitest for tests. 9 production deps total — lean by design, every dep justified.

**The integrations.** Five vendor APIs:
1. **Tesla Fleet API** — Powerwall + solar + Wall Connector (writes to backup_reserve_percent, autonomous)
2. **Enphase Enlighten v4** — solar production + consumption (OAuth)
3. **Rivian unofficial GraphQL** — vehicle reads (CSRF + login + email-OTP, three custom headers)
4. **Smartcar V3** — vehicle reads fallback (M2M + sc-user-id pattern, signals API)
5. **Open-Meteo** — keyless forecast, hourly + daily

**The journey, in four acts.**

1. **Days 1–5: Build.** Scaffold to working product. Decision engine, all four read integrations, dashboard, settings, activity feed. Two production incidents along the way (~$8 in avoidable peak imports), both with full postmortems and structural fixes. The discipline gets codified: "fail loudly, never to plausible-looking values" + "tariff-environment assumptions are not invariants."

2. **Day 6–7 morning: Hit the wall.** Build Rivian command API v5 end-to-end. Live test fails — `state:4 / responseCode:1047 (paired-key required)`. Pivot to Smartcar V3 commands. Live test fails — `409 DEVICE_PAIRING_REQUIRED`. Run a 5-hour BLE feasibility spike. Inference: Gen 2 Rivian uses Apple Car Key, secure-enclave-bound, cannot be initiated from any non-Apple-enclave device. **No software architecture solves this for this car.**

3. **Day 7 afternoon → 8: Pivot and ship.** Lock the strategic decision: Helios is a *decision engine with manual-action UX*. Revert dead actuator code (1,723 lines deleted, build green at every step). Build recommendation engine (pure function + 11 tests). Embed signatures as markers in the action reason field for dedup-without-migration. Build full Web Push infrastructure (Service Worker + VAPID + push_subscriptions table + sub/unsub routes + iOS-aware browser flow). Verify end-to-end round-trip on iPhone PWA. Polish: skeleton loading, hydration fix, DB Date bug, tap-to-reveal tooltips, gross Spent/Credit numbers, engine fix when PW is at 100%.

4. **Days 12–26: Production hardening.** Four more incidents surface in the first eight days after launch, most of them tracing to a single structural pattern (the integral projection knows endpoints but doesn't model trajectories). Each gets a postmortem the same day and a tactical fix in the hour: Day 12 phantom-start pushes + projection math bug, Day 13 reserve-floor grid imports ($1.34), Day 14 Rivian backend outage cascade ($3.11), Day 15 overnight-no-daylight ($0.49). Two new decision-engine gates land in this period: Gate 1d (high-priority alarm when the car is charging from grid at floor, independent of EV-side signals) and Gate 2.5 (suggest raising the Rivian limit when solar is exporting). Day 25 free-tier database hits its compute cap — *the data-source plumbing built for Day 6 surfaces every source as unavailable, refuses to render mock as real, and the cron pauses cleanly.* Day 26 ships a 10s read-side cache + tab-bar elevation polish + drag-to-scrub on the history chart with a portable spec written up for porting to other projects.

**The negative-result archive.** Multiple persistent memory files capture "we tried X, here's why it doesn't work" with empirical evidence and architectural implication. Future sessions don't re-investigate. *That* is senior practice.

---

## What's special, in three sentences

1. **Real product, real users, 19 days of production.** My wife and I use it every day. Saves us money on every sunny day; surfaces actionable recommendations on every not-sunny one; survives its own failure modes with documented postmortems.
2. **The pivot is the moat, the post-launch hardening is the demonstration.** A lesser product instinct builds the decision engine and ignores the actuator gap. A different product instinct burns weeks trying to crack Apple Car Key. I did neither — ran the empirical tests, accepted the negative result, reframed the product. Then ran it in production for 19 days and let real failure modes shape the engine: every incident a postmortem, every postmortem a structural fix or a documented limitation.
3. **The discipline is the demonstration.** 201 atomic commits, 161 unit tests, 7 postmortems, 8+ persistent-memory facts, zero deferred lint debt. Two new decision-engine gates earned through real incidents. This is what senior practice looks like when you point it at a new substrate.

---

## Quantitative summary

```
Calendar days:                                         26 (8 to launch, 19 in production)
Commits:                                              201
Lines of TypeScript (app code):                   ~16,000
Unit tests passing on last commit:             161 / 161
API routes:                                           30+
Database migrations:                                   18
Vendor APIs integrated (read):                          5
Vendor APIs integrated (write):                         1 (Tesla, autonomous)
Vendor API actuator paths abandoned with proof:         3
Production incidents survived:                          7
Postmortems written:                                    7
Memory files (persistent project facts):               8+
Decision-engine gates added post-launch:                2 (Gate 1d alarm, Gate 2.5 limit-raise)
Strategic pivots locked from negative findings:         1
End-to-end push round-trip latency, verified:        <5s
Production deps:                                        9
```

---

## Pointer index

- **Full case study:** [docs/case-study.md](case-study.md)
- **One-page email version:** [docs/case-study-email.md](case-study-email.md)
- **Operational handoff (for another developer / agent picking it up):** [docs/session-handoff.md](session-handoff.md)
- **Postmortems:**
  - [Mock-data incident (2026-04-29)](postmortems/2026-04-29-mock-data-incident.md)
  - [Rivian schedule trap (2026-04-30)](postmortems/2026-04-30-rivian-schedule-trap.md)
  - [Option B implementation (2026-05-01)](postmortems/2026-05-01-option-b-implementation.md)
  - [Phantom-start + projection bug (2026-05-06)](postmortems/2026-05-06-phantom-start-and-projection-bug.md)
  - [Reserve-floor grid imports (2026-05-07)](postmortems/2026-05-07-reserve-floor-grid-imports.md)
  - [Rivian outage cascade (2026-05-08)](postmortems/2026-05-08-rivian-outage-overnight-grid-imports.md)
  - [Overnight charging without daylight (2026-05-09)](postmortems/2026-05-09-overnight-charging-without-daylight.md)
- **Portable interaction spec:** [docs/drag-to-scrub-pattern.md](drag-to-scrub-pattern.md)
- **Engineering primer / glossary:** [docs/engineering-primer.md](engineering-primer.md)
- **Older 5-day-mark snapshot:** [docs/case-study-v1-5day-snapshot.md](case-study-v1-5day-snapshot.md)
