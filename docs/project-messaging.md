# Helios — project messaging

A working reference for talks, presentations, recruiter conversations, LinkedIn posts, and portfolio copy. Curated from the title-and-framing workshop. Pick the line that matches the audience and the slot.

---

## The thesis sentence

Use this verbatim. It is the single sharpest articulation of why Helios exists:

> **Without the asymmetry in the state's tariff, the grid is an infinite battery and Helios isn't necessary. With it, every hour has different value, and the orchestration layer becomes load-bearing.**

This sentence does three things at once: it explains *why* the product exists, it indicts the policy without ranting, and it makes every technical decision in Helios suddenly legible. Forecast-driven scheduling? *Necessary because time matters now.* Battery-first sunset target? *Necessary because peak imports cost 14× what daytime exports earn.* EV-charging from surplus? *Necessary because the grid won't bank surplus for you anymore.* Every gate in the decision engine traces back to that one broken symmetry.

If you only memorize one paragraph from this doc, memorize that one.

---

## The story arc, in one breath

> California asked homeowners to do two civically valuable things — install clean generation and reduce grid demand. NEM 3.0 then made the math punish both. Helios is the orchestration layer the policy stopped providing.

That's the elevator pitch. *Invitation → betrayal → response.* The same arc your story actually has.

---

## Title options, by tonal register

### Long descriptive (the original rhythm, evolved)

Building on Eliel's working title — *"Helios — making actionable sense of weather forecasts, three hardware and software vendors and one utility monopoly"* — and sharpening with the policy-asymmetry frame:

- **Helios — Making actionable sense of weather forecasts, three vendor APIs, and the inverse economics a green state baked into its tariff.**
- **Helios — Weather forecasts, three vendor APIs, a utility monopoly, and an iPhone that owns my car.**
- **Helios — Three vendor apps that don't talk, one utility that won't budge, and the eight days I spent fixing the gap NEM 3.0 created.**
- **Helios — Forecasts, four vendor clouds, and the orchestration layer NEM 3.0 made necessary in a state that asked us to install solar.**

### Punchy with policy edge

- **California asked us to install solar. PG&E made the math punish us for using it. Helios is what I built in response.**
- **Going green in a green state shouldn't cost 14×. It does. So I built around it.**
- **A clean-energy product for a state that monetizes the asymmetry.**

### Direct policy-critical

- **Inverse economics in a green state: building Helios.**
- **PG&E penalizes clean home production. Helios is one homeowner's response.**
- **The orchestration layer the green state forgot to legislate.**

### Story / SOAR-aligned (the hero's journey)

- **Three closed paths and a pivot.**
- **The product I built first was wrong. The product I shipped was the pivot.**
- **When the API says yes but the car says no.**
- **I built a decision engine. Then I had to stop it from doing the most important thing.**
- **From actuator to recommendation: how the OEM constraint reshaped Helios.**

### Senior-design-leader / portfolio angle

- **Beginner coder, senior judgment.**
- **The senior moves AI tools can't make: a home-energy case study.**
- **Eight days. Four vendor APIs. One real product.**
- **A designer's case study in shipping when the architecture's ceiling is hardware.**

### Architectural / technical-talk angle

- **Decisions in the cloud, authority on the device.**
- **The decision engine my house needed.**
- **Cloud computes. Phone authorizes. The architecture that survived the OEM wall.**

### Punchy / single-sentence (headline / slide-1 / scroll-stopper)

- **I shipped my house.**
- **The thermostat I built because no one else would.**
- **The orchestration layer my house was missing.**
- **The most valuable automation turned out to be impossible. So I shipped the second-most.**
- **$0.04 in. $0.58 out. Why I built a thermostat for my whole house.**

---

## Top three picks, with reasoning

### 1. *Helios — Making actionable sense of weather forecasts, three vendor APIs, and the inverse economics a green state baked into its tariff.*

The closest evolution of the original working title. Same rhythm. *"Inverse economics"* carries the policy frustration in two words. *"A green state"* punches without naming PG&E directly — which is more legally and professionally tactful, and lets the reader fill in the blank.

**Use for:** the long-form article. Body of an email. Portfolio page header.

### 2. *California asked us to install solar. PG&E made the math punish us for using it. Helios is what I built in response.*

Three sentences, each earning its keep. The arc — invitation, betrayal, response — is the same arc your story actually has. Names PG&E directly because in a presentation context the audience expects you to name names.

**Use for:** slide 1 of a deck. First line of a LinkedIn post. The opener of a recruiter call.

### 3. *Three closed paths and a pivot.*

Six words. Best for the senior-judgment audience (recruiters, design leaders, engineering directors). Hints at empirical rigor (*closed paths*, not "I gave up"), telegraphs that the story has structure (*a pivot* is a decision, not a defeat), and the brevity is itself a flex. Lets the body do the work.

**Use for:** title slide of a senior-leadership talk. Section header in a long-form article. Closing slide that reframes the entire deck.

---

## Recommended combination across artifacts

| Surface | Title to use |
|---|---|
| Long-form article | #1 — *Helios — Making actionable sense of weather forecasts, three vendor APIs, and the inverse economics a green state baked into its tariff.* |
| Title slide of a presentation | #3 — *Three closed paths and a pivot.* |
| Closing slide / takeaway | **Decisions in the cloud, authority on the device.** |
| LinkedIn post / portfolio thumbnail | **$0.04 in. $0.58 out. Why I built a thermostat for my whole house.** |
| Recruiter intro / one-breath pitch | #2 — *California asked us to install solar. PG&E made the math punish us for using it. Helios is what I built in response.* |
| Section header inside the article | **The orchestration layer the green state forgot to legislate.** |

---

## Ready-to-use phrasings for talks and conversations

### Opening line, any context

> *"Without the asymmetry in the state's tariff, the grid is an infinite battery and Helios isn't necessary. With it, every hour has different value, and the orchestration layer becomes load-bearing."*

### Slide subhead under Diagram 3 (NEM 3.0 asymmetry)

> *"NEM 3.0 didn't change the physics. It changed the math. The grid stopped being a battery."*

### Recruiter conversation, one breath

> *"It's a workaround for a policy contradiction. California asked us to install solar; the tariff structure penalizes us 14× for using it wrong. So I built the timing layer the policy took away."*

### Designer-leadership framing (claiming the senior move)

> *"The product question I had to answer first wasn't 'how do I build this' — it was 'what changed about my house's economics that made coordination suddenly necessary?' The answer was the tariff. Everything technical follows from that."*

### Honest closing line

> *"If California ever rewires NEM 3.0 to restore symmetric pricing, Helios's decision engine becomes obsolete on the same day. That's a feature, not a bug. The product exists because the policy is broken; if the policy gets fixed, the product was a transitional layer worth building anyway."*

---

## The political framing, in plain English

What's happening here, clearly stated:

- California's climate policy nominally asks homeowners to do two civically valuable things: **install clean generation** and **reduce grid demand**.
- NEM 3.0's tariff structure economically punishes both — exports pay flat ACC (~$0.04/kWh) while peak imports cost up to $0.58/kWh, a **14× asymmetry**.
- Under the old policy (NEM 2.0), the grid effectively *was* an infinite battery: push surplus, pull later, no penalty. Time of generation vs. consumption was economically invisible.
- Under NEM 3.0, the grid stopped being a battery and started being a one-way drain priced at 14×.
- That asymmetry is what *creates* the need for coordination — forecasts, schedules, multi-vendor optimization. None of it is needed if the meter doesn't penalize you for getting timing wrong.
- Helios is the response to that policy gap: an orchestration layer the homeowner builds because the state stopped providing one.

This framing matters because it shifts Helios from "clever optimization" to "necessary workaround." The product gains political resonance. The case study becomes a policy critique.

---

## Words to use, words to avoid

**Use:**
- *Asymmetry, inverse economics, orchestration layer, timing tax*
- *The state asked us to install solar*
- *The policy stopped providing one* (referring to the grid-as-battery role)
- *Load-bearing* (when describing what coordination becomes under NEM 3.0)
- *Hardware-level constraint* (when describing the Apple Car Key wall)

**Avoid:**
- *Optimization* (sounds like fine-tuning; this is more fundamental)
- *Smart home* (commodifying tech-stack term; cheapens the product)
- *Self-sufficiency* (sounds like off-grid; this is grid-tied with smart timing)
- *Fight back* (too aggressive; the framing is response, not opposition)
- Naming PG&E in the title for a long-form article (legal/professional caution); fine in a verbal presentation context where you're naming what's true

---

## Cross-references

- **Case study:** [`case-study.md`](case-study.md) — long-form article using title #1
- **Email version:** [`case-study-email.md`](case-study-email.md) — one-page condensed
- **Quick summary:** [`case-study-summary.md`](case-study-summary.md) — 60-second pitch
- **Diagrams:** [`diagrams.md`](diagrams.md) — eight conceptual SVGs; Diagram 3 carries the policy framing visually
- **Postmortem:** [`postmortems/2026-05-01-option-b-implementation.md`](postmortems/2026-05-01-option-b-implementation.md) — what shipped, what didn't, what was learned

*Last updated: 2026-05-02.*
