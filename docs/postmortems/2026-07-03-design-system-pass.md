# Design-system pass — warm-cream to neutral-gray, dark mode, neutral controls

**Date:** 2026-07-03
**Severity:** N/A — design session, not an incident. No production behavior changed; this is a visual-system overhaul.
**Author:** Eliel Johnson (with Claude as co-builder)
**Status:** Shipped and deployed. Commits `2a9e96c`..`c46299f` on `main`, Vercel deploy `dpl_4Nham…`/`dpl_DmMk…` READY on production. Eye-verified on `helios-eliel.vercel.app`.

---

## Summary

Helios shipped with a warm, precise palette: bone/cream surfaces, per-signal colored card-header labels and swatches, and interactive controls that each borrowed one of the semantic energy hues (automation switch green, EV toggle and day selector teal, notifications button orange). This session neutralized the whole surface family to gray, finished the dormant dark theme into a real mode, and standardized every control to a white/grey/black language — freeing the energy colors to mean data and only data.

The through-line decision: **color carries meaning; chrome stays neutral.** Solar amber, battery green, vehicle teal, grid blue, home warm-red, and alert orange are reserved for the data they represent (bars, rings, status, net-cost figures). Surfaces are neutral gray. Controls are white with a hairline keyline, black for the selected/active state.

## What shipped (7 commits)

- `2a9e96c` — neutral gray page background (`--surface-deep` `#EDE7DC` → `#E6E6E6`).
- `2c3bead` — removed the per-signal color swatch from card headers and unified all header labels to a single near-black; dropped the stale swatch from the loading skeleton too.
- `fd1bbd4` — dark mode: finished the `.theme-dark` scaffold with dark-adapted energy hues, neutral dark-gray surfaces, a persisted System/Light/Dark control, a no-flash pre-paint script, and a `theme-color` status bar that follows the surface.
- `2388337` — neutralized the remaining warm surface tokens (`--surface-inset`, `-elevated`, `-warm`, and the warm `--hairline`) to gray. This is what finally killed the tan on the read-only banner, badges, and inset panels.
- `348a5ce` — moved the switches, day selector, and buttons off the energy colors onto the neutral control treatment.
- `4dab45f` — white fill + keyline on the rate chip and the READ-ONLY badges (they read like buttons at grey-fill, and green EXPORTING text was low-contrast on grey).
- `c46299f` — standardized buttons on white fill + keyline + black text (notifications, sign-in-to-save, save-changes), gave the appearance control a white track with a black selected segment, and made the read-only banner white to match the cards.

## Design conventions established (durable — follow these)

1. **Semantic energy colors are for data, never chrome.** `--solar / --battery / --vehicle / --grid / --home / --alert` belong on bars, rings, status text, and net-cost figures. Do not use them to fill a control.
2. **Surfaces are neutral gray.** Page `--surface-deep` `#E6E6E6`; cards `--surface-card` white; recessed/inset `--surface-inset` `#E2E2E5`; the whole family is neutral, not warm. The `/* warm/precise */` comment at the top of `globals.css` is now stale — the system is neutral/precise.
3. **Controls are white with a `--hairline` keyline; black fill is reserved for selected/active states.** Buttons, badges, the read-only banner, and the appearance-control track are white (`--surface-card`) + keyline. Black (`--text-primary`) fill means "on/selected/active" — toggle on, day-of-week active, segment selected. Text on a black fill is `--surface-card`; a toggle knob is `--surface-card` (never hardcoded `white`, which vanishes on the near-white dark-mode track).
4. **Everything is token-driven so it adapts to dark automatically.** New UI should reach for `--surface-*` / `--text-*` / `--hairline`, not literal hexes. A hardcoded `white` reads correctly in light and wrong in dark.

## Dark mode — how it works now

- `.theme-dark` on `<html>` flips the CSS custom properties in `globals.css`. Light energy hues go muddy on near-black (home maroon `#8B1A3F`, vehicle teal `#0E8AA8` were the worst), so the dark block redefines them raised in luminance, plus dark-appropriate `-soft` variants.
- Activation is both: follows the OS by default and honors a persisted `System/Light/Dark` control in Settings (`localStorage` key `helios-theme`, per-device). State lives in `ThemeProvider` (`lib/theme.ts`); the control is `components/ThemeControl.tsx`.
- No-flash is handled by a pre-paint inline script in `layout.tsx`, delivered via `next/script strategy="beforeInteractive"` (see lesson 2 below). It also sets the `theme-color` meta so the browser/PWA status bar matches the surface. Shared colors live in `lib/themeColors.ts` (imported by the provider, layout, and manifest).

## Lessons for the next session

### 1. Turbopack serves stale compiled CSS chunks; `rm -rf app/.next` is the fix

A CSS custom-property value change in `globals.css` did not take, even after HMR, a hard reload, and a full `next dev` restart. The dev server kept serving cached chunks under `.next/` (`src_app_globals_css_…single.css` still held the old hex, confirmed by `fetch(cssHref, {cache:'no-store'})`). It was not a service worker (checked) and not a bad edit (the source was correct on disk). **If a token change "doesn't render" in dev, delete `app/.next` and restart — do not keep reloading.** Rule of thumb: TSX/HMR changes hot-reload fine; CSS-variable value changes can get stuck in the Turbopack chunk cache.

### 2. React 19 warns on inline `<script>` in JSX; use `next/script beforeInteractive`

The no-flash theme script, written as a raw `<script dangerouslySetInnerHTML>` in the layout, triggered a repeating React 19 dev error ("Encountered a script tag while rendering React component… never executed on the client"). Moving it between `<head>` and `<body>` did not help — the warning is inherent to a raw inline script in React's render tree. `next/script strategy="beforeInteractive"` fixed it: Next injects the script into the document itself rather than the render tree. It still runs before hydration, so no-flash is preserved. The warning is dev-only (absent in the production build) but the `next/script` route is the clean answer.

### 3. Config-gated Settings UI cannot be eye-verified locally — the local DB is down

The local Neon credential (`neondb_owner`) fails auth, so `/api/config` and `/api/integrations` 500 locally and the Settings page shows `loading config…`. That means the automation switch, EV policy form, day selector, save button, read-only banner, READ-ONLY badges, and notifications button **do not render on localhost**. They are code-verifiable (`tsc` + matching the proven token pattern) but only eye-verifiable on production. Workflow that worked: commit → push → wait for Vercel READY → drive the real `helios-eliel.vercel.app` with the claude-in-chrome browser MCP (the built-in preview browser is sandboxed to localhost and refuses external URLs). Anonymous = read-only view, which is exactly the banner/badges/sign-in state; admin-only elements (the editable Save button) still can't be seen without signing in.

### 4. The preview MCP console buffer retains stale errors across reloads

Chasing the React script warning wasted cycles because the preview's captured console buffer accumulates (caps ~500) and does not clear on `console.clear()` or navigation. To tell fresh errors from ghosts, emit a unique `console.error` sentinel, reload, then read logs and check whether anything appears after the sentinel. That is how the "script warning is gone" claim was actually confirmed.

## Not verified (open follow-ups, not bugs)

- **Admin "Save changes" button** — changed to white/black/keyline (`c46299f`) but only renders when signed in and editing. Code-verified; shares the exact treatment as its read-only twin "Sign in to save," which was confirmed white on production.
- **Real-device iOS PWA status bar** — the dynamic `theme-color` meta covers Android and in-browser iOS Safari, and follows the manual override. But an installed iOS PWA reads `apple-mobile-web-app-status-bar-style` at launch and can't switch live, so a manually-forced dark theme on the installed iPhone app won't perfectly re-tint the bar. Set to `default`. Worth a glance on the actual phone.
- **`globals.css` header comment** is stale (`warm/precise`) — cosmetic, left as-is.
- **Dead props parked, not removed:** `Card.tsx` and `DashboardSkeleton.tsx` still accept a `signal` prop that is no longer used (kept in case a colored accent wants it back); `NotificationsCard`'s `buttonVariant` is now unused since primary and ghost buttons render identically.

## What did NOT change

No engine, decision, cron, provider, schema, or migration changes. This was surfaces, tokens, and control styling only. Production behavior (Powerwall reserve writes, EV recommendations, Web Push) is untouched from the state left by the 2026-05-09 postmortem.
