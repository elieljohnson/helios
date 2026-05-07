# Reserve-floor blind spot — $1.34 of grid imports during off-peak charging

**Date:** 2026-05-07
**Severity:** P1 — actual cost ($1.34, off-peak rate; would have been ~$2 at peak), eroded user trust ("I'm getting exasperated"), but no compounding harm — caught within ~30 min of the imports starting.
**Author:** Eliel Johnson (with Claude as co-builder)
**Status:** Shipped — projection-formula fix (reserve-floor clamp) prevents authorizing the bad plan; Gate 1d alarm catches any runtime slip past floor; production migrations applied; push notifications restored after iOS update.

---

## Summary

On a non-parked driving day, the engine recommended *"charge to 80%, Powerwall drops to 0% by departure, refills to 100% by sunset."* The user followed the recommendation. Powerwall drained to **20%** (Tesla's reserve floor) — not 0% — and Tesla then refused further discharge. The car kept drawing 11.2 kW from the Wall Connector. Solar was only 1.5 kW that morning. The remaining ~9.5 kW came from **grid imports at $0.36/kWh** off-peak. The engine fired no stop push during this window. The user noticed manually after ~30 min, stopped the car, and arrived in chat *"getting exasperated."*

The root cause: the projection's driving-day target-at-departure formula clamped at zero, not at the reserve floor. Eight kWh of "drainable PW" the engine thought existed were physically untouchable; the projection's math closed only because grid imports filled the gap, but the projection didn't know about grid imports.

Three secondary failures surfaced in the same session, unrelated in cause but compounding the user experience: (a) push notifications had stopped working after an iOS update silently invalidated the device's subscription, (b) the *Rivian (direct)* integration showed a visible GraphQL validation error from yesterday's geofence work, and (c) `/api/actions` was 500ing because production migrations 0014–0018 had never been run.

## Timeline (PT)

- **2026-05-07 ~07:32** — Engine fires *"Driving day — charge to 80%. Powerwall drops to 0% by departure, refills to 100% by sunset."* User taps the limit and starts charging.
- **~08:00** — Powerwall reaches 20% reserve floor. Tesla cuts further discharge.
- **08:00 → 08:30** — Car continues drawing 11.2 kW. Solar 1.5 kW; remainder ~9.7 kW imports from grid. No engine-fired stop.
- **08:30** — User opens dashboard, notices the **10.6 kW grid bar** in the Supply card. Realizes.
- **08:50** — User manually stops the car. Cost reads $1.34 for the day.
- **08:50** — Engine fires another push: *"Driving day — charge to ~73%. Powerwall drops to 5% by departure."* Same broken projection, just a different number after a few minutes.
- **~10:30** — User in chat: *"this is not working as intended."* Triage begins.
- **10:33** — Pulled `/api/status`, snapshot data clean. Pulled `/api/actions` — **500 error**. Diagnosed as production migrations 0014–0018 never applied.
- **10:35** — *Rivian (direct)* row in Settings showing `GRAPHQL_VALIDATION_FAILED` from yesterday's geofence query. Reading the error against the query I wrote: `gnssLocation` doesn't follow the `RivianVehicleStateField<T>` wrapper convention — its lat/lng are direct subfields. Fixed in **`b9f5d59`**.
- **10:40** — User mentions push notifications stopped after iOS update. Diagnosis: standard iOS PWA stale-subscription pattern; reinstalling the PWA + re-toggling the Settings notification card forces re-subscription. Added a **"Send test push"** button to the NotificationsCard so end-to-end verification doesn't require waiting for a cron tick (`c7bf9ab`).
- **10:48** — User reports READ-ONLY badge wraps awkwardly on the *Rivian (via Smartcar)* row. Layout fix in **`9702957`**.
- **10:50** — User confirms re-installed PWA, *"Send test push"* button works, push lands.
- **11:00** — Diagnosed the morning's actual root cause: reserve-floor blind spot in the projection. Driving-day branch: `pw_target_at_departure_kwh = max(0, sunset_target − post_dep_surplus)` — clamps at zero, not at reserve floor. Sunny-driving-day with surplus far exceeding the gap → target_at_departure = 0 → engine authorizes draining "all of PW" → reality stops at 20% → grid fills the rest.
- **11:15** — Shipped **`29674c4`**: clamp at `pw_reserve_floor_kwh` instead of zero. Plumbed `config.reserve_floor_pct` through `decideEvCharge` to `projectPwTrajectory`. Regression test pins the screenshot scenario.
- **11:21** — Shipped **`ccb307a`**: new Gate 1d in `decideEvCharge`. When EV is drawing AND PW at-or-below `reserve_floor + 2%` AND grid is importing > 1 kW, return `action: "stop"` immediately. Runtime backstop for any case the projection doesn't catch (manual override, projection drift, vendor-data lag).
- **11:30** — User starts production migration. Pasted the production `DATABASE_URL` (containing the database password) into chat by accident.
- **11:31** — **Credential rotation triggered.** User reset the `neondb_owner` password on Neon, updated `DATABASE_URL` in Vercel, Vercel auto-redeployed. The compromised credential's exposure window was ≤ 5 min; rotation closed it.
- **11:50** — User runs `npm run db:migrate` against `.env.local` (which already pointed at production with the new password). Migrations 0014–0018 apply. `/api/actions` returns 200.

## What we shipped

| Commit | Type | What |
|---|---|---|
| `b9f5d59` | fix | **Rivian gnssLocation GraphQL shape.** Yesterday's geofence work guessed wrong about the field shape — `gnssLocation` doesn't follow `RivianVehicleStateField<T>` wrapping; lat/lng are direct subfields under it. Fixed query + types + consumer. Unblocks anyone trying to connect the *Rivian (direct)* integration. |
| `c7bf9ab` | feat | **"Send test push" button in Settings.** Wires the existing `/api/admin/test-push` endpoint to a button on the NotificationsCard. Visible only when subscribed. Removes the need to wait for a cron tick to verify push round-trip after re-subscribing. |
| `9702957` | style | **READ-ONLY badge layout.** The badge was inline with the provider name, causing wrap on long names ("Rivian (via Smartcar)"). Restructured to flex-column on the left side of each provider row; badge always sits below the name, ActionButton stays right-aligned. |
| `29674c4` | fix | **Reserve-floor clamp in driving-day projection.** Root cause of the morning's grid imports. Driving-day target was `max(0, sunset_target − post_dep_surplus)`; should be `max(reserve_floor, sunset_target − post_dep_surplus)`. Engine no longer authorizes plans that imply grid imports during charging. Net effect: smaller recommended charge limits on driving days, but $0 grid imports. |
| `ccb307a` | feat | **Gate 1d — runtime alarm.** When EV is drawing AND PW at-or-below `reserve_floor + 2%` AND grid importing > 1 kW, return `action: "stop"` immediately. Forward-looking projection prevents the bad plan; this gate is the runtime backstop. Push body names the situation specifically: *"Powerwall at reserve floor — car charging from grid"* with the live TOU rate quoted. |
| migrations | infra | **0014–0018 applied to production DB.** Five migrations had been written and pushed but never run. `/api/actions` had been 500ing since yesterday because Drizzle expected schema columns that didn't exist on the production tables. Applied via `npm run db:migrate` against the rotated DATABASE_URL. |

Two atomic commits earlier in the session (`b9f5d59` + `c7bf9ab`) handled the visible-error and push-test issues; three later commits (`9702957`, `29674c4`, `ccb307a`) handled the layout glitch and the actual P0. The credential rotation + production migrations were operational steps, not commits.

## Why the bug was dormant until now

The reserve-floor clamp was missing on the driving-day branch since it was first written — but the bug only fires under specific conditions:

1. **Driving day** (parked-day branch doesn't have the same formula; live re-evaluation catches floor approaches in real time)
2. **Strong post-departure forecast** (so `surplus_post_dep_kwh > sunset_target_kwh` and the math goes negative, clamping at 0)
3. **Weak morning solar at the moment of charging** (so PW supplies most of the EV draw and runs out fast)
4. **PW starts the morning above the threshold but not full** (so the drain crosses reserve floor during the charging window, not after)

Most days don't hit all four. Sunny driving days where solar comes up early enough that morning charging is solar-heavy don't surface the bug — PW doesn't drain to floor. Stormy days don't activate pre-departure relaxation in the first place. Today's combination — wife leaves late, driving day, sunny forecast, weak early-morning solar — was the first time the math closed *only because* of grid imports.

Yesterday's projection-formula fix (`b99dd70`, *"include PW headroom above target as positive EV budget"*) made today's bug *more visible*, not more likely. It correctly accounted for headroom above target, but the headroom was being computed against an unrealistic floor of 0% rather than 20%. The two bugs are a matched pair: yesterday fixed the upper bound (target was capping above PW capacity), today fixes the lower bound (floor was extending below reserve).

## What we did right

- **Took the user's framing seriously.** The user said *"the basic functionality of this app should be to tell me how much to set my charge for in the morning so I don't pull from the grid."* That phrasing was the diagnostic. Once read literally, the answer was *"the engine doesn't know about the reserve floor."* No need to defend the existing math — it was honestly wrong.
- **Two-layer fix, not one.** Reserve-floor clamp prevents authorizing the bad plan (forward-looking). Gate 1d catches anything that gets through anyway (runtime). Either alone leaves a failure mode; together they cover the surface.
- **Tariff dependency cited per AGENTS.md.** Both the projection comment and the Gate 1d comment name NEM 3.0 / NBT and the import/export asymmetry that justifies the alarm. If the user ever switches tariffs the assumptions are loud and re-derivable.
- **Side issues handled in priority order** — push first (so the engine can talk to the user), then the visible Settings error, then the layout, then the actual P0. Migrations last because nothing engine-critical depended on them.
- **Credential rotation was fast and complete.** Exposure window ≤ 5 min from paste to rotated. No evidence of unauthorized DB access.

## What we got slightly wrong

- **The reserve-floor clamp is only on the driving-day branch.** Parked-day projection doesn't enforce the same floor. The argument is "live re-evaluation catches it on the next 5-min tick" — true today, but it's not a math-level guarantee, it's a runtime hedge. A symmetric fix on parked-day (clamp `pw_delta_to_target_kwh` against the floor) would be cleaner. Worth a small follow-up.
- **The `home_geofence_radius_m` field is hardcoded in `rowToConfig` to fall back to the default.** Same pattern as `pw_sunset_safety_margin_pct`. A real Settings card would let the user tune it. Not blocking — defaults are sane — but the path to "user controls the geofence" is incomplete.
- **Production migrations are still a manual operational step.** `/api/actions` was 500ing for ~18 hours because nobody noticed migrations hadn't run on production. Vercel doesn't auto-run them on deploy; we'd have to add a build-step hook or a separate CI job. Worth doing.
- **The `pw_sunset_target_pct` is still hardcoded to 80** in `recommendEvAction.ts` for the natural-limit threshold. We've called this out three sessions in a row. Should land before it bites.
- **The user pasted DATABASE_URL into chat.** Process gap, not a tool failure. The env var contained "user:pass" formatting that's easy to miss-redact during copy. Could harden by always recommending the `vercel env pull` flow (which doesn't require copy-paste) over inline `export DATABASE_URL='...'`. Will document.

## Follow-ups

In rough priority order:

1. **Plumb `pw_sunset_target_pct` through to `recommendEvAction`** (still hardcoded `80`). Trivial; been on the list for three sessions.
2. **Symmetric reserve-floor clamp on the parked-day branch.** Math hardening; the live-re-eval hedge is fine for now but the asymmetry is a smell.
3. **Auto-run migrations on Vercel deploy.** Either a build-step hook (`db:migrate` after build) or a separate CI job. Eliminates the "migrations exist but haven't run" failure mode.
4. **Settings UI for `home_geofence_radius_m` + DB migration.** Only matters if 200 m starts feeling tight or loose.
5. **Layer 4 structural fix per AGENTS.md** — `sources.vehicle.status` threaded through to engine. Three tactical defenses (Gate 1, 1b, 1c, 1d) cover the failure modes; the structural fix is the right long-term answer to the vendor-data class of bugs but isn't urgent.
6. **Learned overnight-target feature** — revisit in 2–4 weeks once `daily_summaries.morning_low_pw_pct` and `evening_high_pw_pct` have meaningful sample size.

## Files changed across this session

15 files, 6 commits, 0 reverts.

```
app/src/lib/rivian/types.ts                    (gnssLocation type shape correction)
app/src/lib/rivian/client.ts                   (gnssLocation query + getEvSnapshot reader)
app/src/components/cards/NotificationsCard.tsx (Send test push button)
app/src/components/cards/IntegrationsCard.tsx  (READ-ONLY badge layout)
app/src/lib/projectPwTrajectory.ts             (reserve-floor clamp)
app/src/lib/projectPwTrajectory.test.ts        (regression test for screenshot scenario)
app/src/lib/decideEvCharge.ts                  (Gate 1d alarm + reserve_floor_pct plumbing)
app/src/lib/decideEvCharge.test.ts             (4 tests for Gate 1d)
db/migrations/0014–0018                        (applied to production DB)
```

Test count moved from 136 → 141 (+5, all in `decideEvCharge.test.ts` + `projectPwTrajectory.test.ts`).

## Validation

The fix is forward-looking — the regression test pins the screenshot scenario but runs against synthetic data. **The actual validation is tomorrow morning's behavior.** Expected:

- Engine recommends a *lower* charge limit (likely 70–75% rather than 80%) because the new math respects that PW can only deliver from 80% → 20% on the discharge side, not 80% → 0%.
- Push body reads honestly: *"Powerwall drops to 20% by departure"* (not "0%").
- During the morning charging window: zero grid imports. `daily_cost` stays at $0.00 unless something ELSE goes wrong.
- If anything goes sideways anyway → Gate 1d fires within 5 min with a specific reason text quoting the live grid kW.

If tomorrow morning's behavior matches the above, this fix is validated. If not, the engine isn't reading `config.reserve_floor_pct` correctly or the projection's threading has a bug — would surface as either a too-aggressive recommendation (math didn't pick up the clamp) or no recommendation at all (math overcorrected). Either is debuggable from the activity feed.

## Cross-references

- `AGENTS.md` — Production data discipline + tariff-environment assumptions (the framing both bugs trace back to)
- `docs/postmortems/2026-05-06-phantom-start-and-projection-bug.md` — yesterday's session, including the projection formula change that revealed today's reserve-floor blind spot
- `docs/postmortems/2026-04-30-rivian-schedule-trap.md` — original instance of "engine recommends a plan whose math closes by accident" — different mechanism, same pattern
- `memory/feedback_external_api_quotas.md`, `memory/feedback_query_command_state.md` — vendor-data hygiene memos that informed how today's three secondary failures were diagnosed
