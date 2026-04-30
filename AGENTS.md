# Helios — agent orientation

Home-energy intelligence app. Reads from Tesla Powerwall + Wall Connector, Rivian, Enphase, Open-Meteo. Decides PW reserve % and EV charging schedules every 5 minutes. Renders a PWA dashboard.

The Next.js app lives under `app/`. Read `app/AGENTS.md` for project-internal rules (Next.js 16 caveats, production-data discipline, tariff invariants). This file is the repo-root overview.

## Stack

- **Frontend / API**: Next.js 16 (App Router, Turbopack), React 19, SWR, Tailwind v4
- **Database**: Drizzle ORM over Neon Postgres. Custom migration runner in `app/scripts/migrate.ts`
- **Validation**: Zod (request schemas in `app/src/lib/schemas.ts`)
- **Tests**: Vitest. Pure-function decision engines (`decide.ts`, `decideEvCharge.ts`) have full coverage; provider adapters do not (network mocking would be a lift)
- **Deployment**: Vercel. Cron via `app/vercel.json` hits `/api/cron/decide` every 5 min
- **Production URL**: helios-eliel.vercel.app

## Build / test / deploy

All commands run from `app/`:

```bash
npm run dev              # Local dev server
npm run build            # Verify before commit on bigger changes
npm run test             # Vitest, runs once
npm run test:watch       # Vitest watch
npx tsc --noEmit         # Typecheck without building
npm run db:migrate       # Run pending migrations against Neon
npm run db:migrate:status  # See applied/pending without running
```

**Migrations don't auto-run on Vercel deploy.** Run `npm run db:migrate` BEFORE `git push` whenever a migration was added, or Drizzle SELECTs will 500 on the missing column. The migration runner reads `.env.local`.

## Project structure

```
Helios/
├── AGENTS.md                  # This file (orientation)
├── app/                       # Next.js project
│   ├── AGENTS.md              # Project rules (must-read for code changes)
│   ├── CLAUDE.md              # Imports AGENTS.md
│   ├── src/
│   │   ├── app/api/           # Route handlers (cron, status, preview-decision, integrations, etc.)
│   │   ├── app/page.tsx       # Dashboard (also activity, settings)
│   │   ├── components/        # React components (cards/, AppShell, FreshnessIndicator, …)
│   │   └── lib/               # decide.ts, decideEvCharge.ts, status.ts, db.ts, types.ts, mock.ts, providers (tesla/, rivian/, smartcar/)
│   ├── db/migrations/         # SQL migrations (numbered)
│   └── scripts/               # migrate.ts, wc-poller.ts
└── docs/
    ├── case-study.md          # Portfolio narrative
    ├── engineering-primer.md  # Glossary + concepts
    ├── postmortems/           # One per real incident
    └── session-handoff.md     # Latest session-to-session handoff
```

## Conventions

- **Atomic commits**, conventional prefixes (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`). One concern per commit.
- **Bash cwd resets between calls.** Always prefix npm with `cd /Users/Eliel/Projects/Helios/app &&` (absolute path) — relative paths break the second time.
- **Postmortems live at the repo root** under `docs/postmortems/YYYY-MM-DD-slug.md`. Project-internal AGENTS rules cite them by relative path from `app/`.
- **Type-system enforcement over runtime checks** where possible. The data-source plumbing (`StatusResponse.sources`) deliberately uses required fields so consumers can't accidentally read undefined.
- **No emojis in code, comments, or docs.** Prose voice; short paragraphs over bullets where practical.
- **Don't ship behavioral changes at midnight after a P1.** Lessons get filed; tactical patches go out; structural changes wait for daylight.

## Security & secrets

- **`.env.local`** holds tokens (Tesla, Rivian, Smartcar, Enphase OAuth). Never commit. `.env.local.example` is the redacted template.
- **`.tesla-keys/`** holds the Tesla Fleet API partner-domain registration keypair. Never commit.
- **`CRON_SECRET`** gates `/api/cron/decide` against unauthenticated invocation. Set in Vercel env, optional locally.
- **`ADMIN_TOKEN`** gates Settings + write APIs. The /api/me hook decides admin-vs-public; public visitors see a redacted `system.coords` (lat/lng would identify the home).
- **DB writes from cron are unwrapped on most paths.** A Neon hiccup currently surfaces as a 500. `getConfig()` is wrapped (commit `027e0a8`). Others are open todos.

## Gotchas

1. **Tariff matters.** Helios runs on **PG&E E-TOU-C** under **NEM 3.0 / NBT** (flat ~$0.04/kWh export, peak imports $0.58/kWh). Cost-minimization rules are tariff-specific. Pre-2026-04-30, a peak-reserve guard from NEM 2.0 cost the user ~$900/year; see `app/AGENTS.md` "Tariff-environment assumptions are not invariants" and `docs/postmortems/2026-04-30-rivian-schedule-trap.md`.

2. **Rivian schedule mutations are not stop commands.** `setChargingSchedules` configures permitted charge windows ("Charge off-peak and save"), not imperative stops. `stopCharging` is currently a no-op (commit `12a2d27`) until a one-shot `CHARGE_STOP` is wired via the vehicle-command API. See P0 todo and the 2026-04-30 postmortem.

3. **Rivian has at least three autonomous behaviors** that fight user/Helios input. Schedule re-creation, default-charge-to-limit when no active schedule, profile-level charge-limit auto-revert. Documented in 2026-04-30 postmortem.

4. **`mockStatus()` ships in production.** Calibrated for sunny-noon dev (`solar_w=7700`, `pw_soc=78`), so a mid-day provider failure used to be safe and a 2 AM failure was the 2026-04-29 incident. Cron now refuses to act when sources aren't `"live"` (commit `877154b`). Moving mock out of the prod bundle is an open todo.

5. **Tesla gateway can briefly desync CT readings.** A snapshot can have one of `solar_w / home_w / pw_w / grid_w` momentarily inconsistent with the others. HeroCard now renders an imbalance warning when `|supply − demand| ≥ 0.5 kW` (commit `f52b85b`); recovers on next snapshot.

6. **`home_w` (Tesla `load_power`) includes EV draw.** UI splits it into "House" (`home_w − ev_w`) and "Rivian" so the EV isn't double-counted. Don't add EV separately on top of `home_w` anywhere.

7. **PT timezone everywhere.** PG&E TOU schedule, parked-day index, sunset/sunrise, daily rollups all in `America/Los_Angeles`. UTC sneaks in via Vercel; check before computing.

8. **Sign convention: `pw_w > 0` is discharging, `pw_w < 0` is charging.** Matches Tesla's `battery_power`. Same for `grid_w` (positive = import).
