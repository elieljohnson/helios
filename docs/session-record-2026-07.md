# Session record — July 2026 (design system → engine audit → charging exploration)

One long working session, three arcs, 13 commits (`2a9e96c`..`f6b29c1`), all shipped and — where deployable — live on production. This is the single end-to-end record; the two topical postmortems and the rolling handoff below hold the depth.

**Detailed sources:**
- `docs/postmortems/2026-07-03-design-system-pass.md` — the visual overhaul (arc 1).
- `docs/postmortems/2026-07-07-engine-audit-and-charging-alternatives.md` — the audit + charging exploration (arcs 2–3).
- `docs/session-handoff.md` — forward-looking state + open threads (latest on top).
- Memory: `project_design_system`, `feedback_local_ui_verification`, `project_rivian_cloud_exhausted` (+ the existing Apple Car Key / integration-strategy entries).

---

## Arc 1 — Design-system overhaul (shipped + deployed + eye-verified on production)

Started from a request to change the visual system; landed a full re-tone from warm-cream to a neutral, dark-mode-capable system with a consistent control language.

- `2a9e96c` neutral gray page background (`#E6E6E6`, replacing warm `#EDE7DC`).
- `2c3bead` removed per-card color swatches; unified card-header labels to one near-black.
- `fd1bbd4` **dark mode** — finished the dormant `.theme-dark` into a real mode: dark-adapted energy hues, neutral dark-gray surfaces, a persisted System/Light/Dark control, a no-flash pre-paint script (`next/script beforeInteractive`), and a `theme-color` meta that follows the surface. System-default + manual override.
- `2388337` neutralized the remaining warm surface tokens (inset/elevated/warm/hairline) — killed the tan on the read-only banner, badges, and inset panels.
- `348a5ce` moved switches / day selector / buttons off the energy colors onto a neutral treatment.
- `4dab45f` white-fill + keyline on the rate chip and READ-ONLY badges (they read like buttons at grey-fill; green EXPORTING was low-contrast).
- `c46299f` standardized buttons on white fill + keyline + black text; white appearance-control track with a black selected segment; white read-only banner.

**Durable rule that emerged:** semantic energy colors are for **data only**; controls are **white + hairline keyline**; **black fill = selected/active state** (toggle on, day active, segment selected). Build with tokens, not hexes, so everything adapts to dark automatically. Every change was eye-verified on live production via the claude-in-chrome browser (the local DB is down, so config-gated Settings UI only renders on prod).

## Arc 2 — Engine audit (three bugs found, fixed, tested, deployed)

A logic audit of the decision-critical code (`decide.ts`, `decideEvCharge.ts`, `recommendEvAction.ts`, `status.ts`).

- `03d786a` **(1)** `decide.ts` double-counted the EV in surplus (`solar − home_w − ev_w`, but `home_w` already includes the EV) — silently disabled the "bank surplus in PW while charging" guard. **(2)** `pw_reserve` could read the mock seed while the Powerwall showed "live" (nested `site_info` try/catch) — now forces the reserve write when provenance is stale. Both with regression tests that fail on the old code.
- `fad455a` **(3)** push classification keyed on `reason` text across a file boundary — replaced with a structured `stopKind`, pinned by producer- and consumer-side tests.

162 tests pass, `tsc` clean, deployed (`dpl_9mKF…` READY). No migration.

## Arc 3 — Charging automation, explored with Fable (dead ends mapped; one experiment parked)

A fresh attempt — with Fable as a second model — to find a Rivian charging-automation path not already ruled out.

- `b027346` + `bfdc95e` the Rivian schedule-surface spike (`scripts/rivian-schedule-spike.ts`): single-run login (inline OTP prompt), then introspection → name-probe fallback.

**What we established (definitive):** Rivian's gateway **blocks GraphQL introspection AND masks all field errors** → remote schema discovery is dead, do not re-attempt. The car-command surface (Rivian/Smartcar/BLE, incl. the reverted command-based `setChargeLimit`) is closed by Apple Car Key. The Tesla Wall Connector is read-only. A local always-on bridge already exists (`scripts/wc-poller.ts`).

**What's left:** one cloud-only question — does a *nonzero*-amperage schedule throttle the car? — answerable only by a supervised live write, which is **wired-but-parked** (Phase 2, gated). The guaranteed-by-physics fallback is replacing the Wall Connector with a smart EVSE (the pilot signal binds the car). Fable's full ranked roadmap and the write-test resume recipe are in the 2026-07-07 postmortem.

## Arc 4 — Documentation (this arc)

- `e8cc378` design-system postmortem + handoff refresh.
- `f6b29c1` engine-audit + charging-alternatives postmortem + handoff refresh.
- This record ties all three arcs together.

## State at session end

All 13 commits pushed; `main` in sync with origin. Production is live on `f6b29c1`'s tree (design + engine fixes deployed; docs/spike don't deploy). No open bugs, no migration pending. The one live thread for a future session is the parked nonzero-amperage write test — or the smart-EVSE decision. Everything needed to resume cold is in the two postmortems and the handoff.

## Vocabulary introduced this session

- **FOUC** — flash of wrong theme before JS applies it; the pre-paint script prevents it.
- **Hydration** — React attaching to server-rendered HTML; a class the server didn't render needs `suppressHydrationWarning`.
- **`beforeInteractive`** — a Next script strategy that runs before hydration, injected into the document rather than React's tree.
- **`prefers-color-scheme` / `matchMedia`** — the OS dark-mode signal and its live subscription API.
- **idempotent** — an operation safe to repeat (writing the reserve target); why forcing the write beats trusting a stale read.
- **provenance** — whether a value is live-real vs mock/stale; the `pw_reserve_live` flag.
- **GraphQL introspection** — asking an API to describe its own schema; Rivian blocks it.
- **pilot signal** — the charger→car handshake dictating max current, binding on the car by standard; the basis of the smart-EVSE path.
- **EVSE** — the wall charger (Electric Vehicle Supply Equipment).
- **pairing wall** — the OEM requirement that a physically-paired device authorize any imperative command; what closes the car-command surface.
