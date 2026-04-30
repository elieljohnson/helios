# Smartcar integration — handoff

**Status (2026-05-01):** Smartcar resolved ticket **#SS100005693**. Two-part fix: (a) sync bug on their vehicle-data service that prevented our R1S from being resolved on data requests, now fixed; (b) clarification that the paths we were probing (`/v3/vehicles/{id}/battery`, `/charge`) are V2-style and never worked on V3 to begin with — V3 uses a signals-based architecture. Connection also expired during the long pendency, so a fresh Smartcar Connect re-auth is required, not just a token refresh.

Helios's Smartcar integration code is intact and dormant. Verification + V3 path migration not yet done.

This file is for the next agent picking up the verification + reintegration work.

## TL;DR

- Built a full Smartcar integration in early April 2026 covering OAuth, vehicle pinning, EV-state read, and charge start/stop. Worked under V2.
- **Broke when Smartcar migrated to V3** mid-build — Rivian dropped from their compatibility list, then partially returned in a state where `/v3/connections` listed the vehicle but `/v3/vehicles/{vehicle_id}` returned 404.
- Filed support ticket #SS100005693 with full reproduction.
- Kept the integration code in place behind a `Smartcar broken pending V3 OAuth resolution` comment so re-enabling is one ticket reply away.
- **Smartcar resolved the ticket on 2026-05-01.** Three things are now true: (1) the sync bug is fixed and the R1S resolves on V3 data requests; (2) our connection expired during the wait — needs full re-auth; (3) **the data-fetching client code in `app/src/lib/smartcar/client.ts` is V2-style and needs a V3 signals-architecture migration before any read or actuator call will work**. The V2-style probe in step 1 of the original "what to do next session" plan was wrong — it would have failed on the data endpoints regardless of the sync fix. Updated probe in this doc.

## Why Smartcar matters now

This isn't just about restoring an old integration. The 2026-04-30 incident proved that Helios's Rivian unofficial-API stop authority is fragile (see `docs/postmortems/2026-04-30-rivian-schedule-trap.md`). The v5 work (separate session, see `docs/session-handoff.md`) wires a proper `STOP_CHARGING` command via Rivian's HMAC-signed command API, but it requires:

- Phone-key enrollment (one-time per device)
- Possible BLE pairing requirement (open question — biggest risk on the v5 plan)
- HMAC signing with ECDH-derived keys from the vehicle public key

**Smartcar, if it works again, is an officially-supported alternative path** for charge control. It uses standard OAuth and has no BLE requirement. Even if the Rivian v5 path proves out, Smartcar is worth keeping wired as a redundant or fallback actuator — the more independent ways to stop the car, the better the system's stop authority.

## What was broken (before the fix)

### Symptom

V3 OAuth Connect succeeded. Connection appeared in Smartcar dashboard as **Live**. Listing connections returned the vehicle correctly:

```
GET https://vehicle.api.smartcar.com/v3/connections
→ 200 OK
   data: [{ id: "<connection-id>", type: "connection",
            attributes: { vehicle: { make: "RIVIAN", model: "R1S", year: 2025, mode: "live", powertrainType: "BEV" } },
            relationships: { vehicle: { data: { id: "<vehicle-id>", type: "vehicle" },
                                        links: { related: "https://vehicle.api.smartcar.com/v3/vehicles/<vehicle-id>" } } } }]
```

But following the self-link Smartcar's own response handed back returned 404:

```
GET https://vehicle.api.smartcar.com/v3/vehicles/<vehicle-id>
→ 404 Not Found
   { errors: [{ status: "404", type: "RESOURCE_NOT_FOUND", code: "VEHICLE_NOT_FOUND",
                detail: "Vehicle with ID <vehicle-id> not found",
                meta: { debug: { requestId: "f54616a8-48a9-4641-9466-29686587c793" } } }] }
```

Sub-paths returned a different error (path validation, not vehicle lookup):

```
GET /v3/vehicles/<vehicle-id>/battery → 404 INVALID_PATH
GET /v3/vehicles/<vehicle-id>/charge  → 404 INVALID_PATH
```

That contradiction in their own API surface — connection lists the vehicle with a self-link, vehicle endpoint says the vehicle doesn't exist — was the smoking gun for the support ticket.

### Endpoints we probed and what each returned

| Endpoint | Result |
|---|---|
| `GET /v3/connections` | ✅ 200, vehicle present |
| `GET /v3/vehicles/{vehicle_id}` | ❌ 404 VEHICLE_NOT_FOUND |
| `GET /v3/vehicles/{vehicle_id}/battery` | ❌ 404 INVALID_PATH |
| `GET /v3/vehicles/{vehicle_id}/charge` | ❌ 404 INVALID_PATH |
| `GET /v3/connections/{connection_id}` | tried (not the right shape) |
| `GET /v3/connections/{connection_id}/battery` | tried |
| `GET /v3/connections/{connection_id}/state-of-charge` | tried |
| `GET /v3/connections/{connection_id}/signals/state-of-charge` | tried |
| `GET /v3/vehicles/{vehicle_id}/signals/state-of-charge` | tried |
| `GET /v3/vehicles/{vehicle_id}/traction-battery` | tried |
| `GET /v3/vehicles/{vehicle_id}/traction-battery/state-of-charge` | tried |

The probe used a Smartcar **M2M client_credentials access token** (from `https://iam.smartcar.com/oauth2/token`) plus the `sc-user-id` header. Same credentials in both the working and failing calls — so authentication wasn't the issue.

## Account / connection IDs (this user's specific values)

```
Application:  a4709213-b79f-468e-86af-c4221a42ba99
Connection:   bb650530-80c7-48e0-822f-1cd4e86e7abd
Vehicle:      9c0d7a1d-d63b-47b8-bdbf-eea34cd7f969
User:         1fa375e5-0e19-4ff9-ab4f-d9b2cbfe91d8
Mode:         live
Plan:         Build
Permissions:  control_charge, read_battery, read_charge, read_vehicle_info
Vehicle:      2025 Rivian R1S (BEV)
```

These are the exact values Smartcar's debug team should reference if they need to reproduce. The `requestId: f54616a8-48a9-4641-9466-29686587c793` from the failing `/v3/vehicles/{vehicle_id}` call is in their logs.

## The ticket we filed

Subject: **`V3 vehicle data API returns VEHICLE_NOT_FOUND for Live connection (Rivian R1S 2025)`**

Component: API (vehicle data). Issue Type: Bug / API Error. Sent direct to support@smartcar.com after their portal login became unavailable.

Body included:
- The IDs block above
- The reproduction snippet (connections returns the vehicle, vehicles endpoint 404s)
- A directional ask: *"Confirm whether this is a Rivian backend sync delay, an R1S 2025 V3 coverage gap, or a configuration issue on my end?"*

The directional ask was deliberate — it forces a categorical answer instead of letting the response default to "we'll look into it."

## Resolution (Smartcar reply, 2026-05-01)

Steve Peck at Smartcar Support, ticket #SS100005693:

> The root cause was a sync issue in our vehicle data service that was preventing your vehicle from being resolved on data requests. This has been fixed — the vehicle is now reachable through the API.
>
> However, while investigating we noticed that the connection to your Rivian has since expired. You'll need to re-authorize the vehicle through Smartcar Connect to establish a fresh session. Once you've done that, your data requests for battery, charge, and vehicle info should work as expected.
>
> To clarify the endpoint paths — the V3 API uses a different structure than V2. Paths like `/v3/vehicles/{id}/battery` or `/charge` are V2-style routes and won't resolve on V3. Please refer to our V3 API documentation for the correct endpoint patterns.

Three distinct things to act on, in order:

1. **Their sync bug is fixed.** The R1S is now resolvable on V3 data requests.
2. **The connection expired** during the ticket pendency. A token refresh isn't enough — the user needs to do a fresh Smartcar Connect through the Settings UI to mint new OAuth tokens.
3. **The path-shape probe in our ticket reproduction was contaminated.** The data endpoints we tested (`/v3/vehicles/{id}/battery`, `/charge`) were *never* the V3 endpoints — those are V2 idioms that 404 with `INVALID_PATH` regardless of the sync state. So:
   - Our `/v3/connections` probe (which returned 200 throughout) was always-correct V3.
   - Our `/v3/vehicles/{id}` probe (which returned 404 VEHICLE_NOT_FOUND, now should 200) was correct V3 — that's the case Smartcar actually fixed.
   - Our `/v3/vehicles/{id}/battery` and `/charge` probes were wrong-API-version. They'll keep returning `INVALID_PATH` even after the sync fix until we use V3-shaped paths.

### V3 architecture — what changed

V3 uses a **signals-based** endpoint pattern instead of per-resource `/battery` and `/charge` paths. Quick orientation from Smartcar's V3 docs:

- The relevant signal groups are **`Charge`** and **`TractionBattery`**.
- Signal definitions live at `smartcar.com/docs/api-reference/signals/charge` and `signals/traction-battery`.
- Get-Signals shape (per the V3 reference): a single endpoint returns one or more signals at a time, rather than a separate REST resource per data type.

The next agent must consult the V3 signal-schema docs before writing client code. The exact endpoint URL, HTTP method, and signal names need verification at write-time — this doc captures the shape ("signals-based, Charge + TractionBattery groups"), not the syntax.

### Implication for `app/src/lib/smartcar/client.ts`

The existing client was built against V2's REST-per-resource shape. Functions like `getEvSnapshot()`, `startCharging()`, `stopCharging()` almost certainly call `/v3/vehicles/{id}/battery`, `/charge`, and similar V2-style paths. Re-enabling Smartcar requires a V3 path migration of this file, not just a token refresh. Estimate: 4–8h depending on how many V3 signals map cleanly to existing function signatures and how the signals endpoint handles bulk reads vs. per-call.

The OAuth/Connect path in `auth.ts` already migrated to V3 in an earlier pass, per the file-header comment — that part stays.

## Current code state (as of 2026-05-01)

The Smartcar integration is intact and dormant. Nothing has been ripped out.

```
app/src/lib/smartcar/
├── auth.ts       # V3 Connect URL builder + OAuth code exchange + M2M client_credentials helper
├── client.ts     # getEvSnapshot, isConfigured, pinVehicleId, startCharging, stopCharging
├── index.ts      # Public surface (re-exports)
└── types.ts      # SmartcarBattery / Charge / VehicleInfo / EvSnapshot types
```

Surface re-exported through `@/lib/smartcar`:

```ts
import {
  getEvSnapshot,
  isConfigured,
  listVehicleIds,
  pinVehicleId,
  saveTokens,
  startCharging,
  stopCharging,
  authorizeUrl,
  exchangeCode,
  getApplicationToken,
  refreshTokens,
  SMARTCAR_SCOPES,
} from "@/lib/smartcar";
```

Where it's referenced today:

- **`app/src/app/api/cron/decide/route.ts`** — line ~388, fallback path in `fireEvAction()`. Comment reads: *"Smartcar (currently broken behind V3 OAuth gap; kept as a configured-but-erroring path so re-enable is one ticket reply away)."* If Rivian isn't configured, cron tries Smartcar.
- **`app/src/lib/status.ts`** — Smartcar overlay block sets `ev_soc`, `ev_range`, and (when Tesla doesn't already supply them) `ev_charging` + `ev_w`.
- **`app/src/app/api/auth/smartcar/`** — OAuth init + callback routes, intact.
- **`app/src/components/cards/IntegrationsCard.tsx`** — Settings panel hides the Smartcar row behind a comment about the V3 gap. Connection UI is dormant pending verification.

The integration is still in `oauth_tokens` (provider="smartcar") if previously connected; reconnect via the Settings UI when ready.

## What to do next session

### Step 1 — Verify the sync fix (M2M probe, no code changes, no car needed) — ✓ DONE 2026-05-01

**Result: both endpoints returned 200. Sync fix confirmed.**

Probe response captured three findings worth carrying forward:

1. **Connection ID rotated.** Original ticket recorded `bb650530-80c7-48e0-822f-1cd4e86e7abd`. Probe returned `81ace3e0-84ec-4f1b-adb6-595c1880b335`. Consistent with Smartcar's "the connection has since expired" — they issued a fresh connection record. Vehicle ID unchanged (`9c0d7a1d-d63b-47b8-bdbf-eea34cd7f969`); only the auth session rotated. The IDs block above keeps the historical values for ticket-history record; current connection ID is the rotated one.

2. **Vehicle resolves cleanly.** `GET /v3/vehicles/{vid}` returns `make: RIVIAN, model: R1S, year: 2025, powertrainType: BEV, mode: "live"`. The `VEHICLE_NOT_FOUND` failure is gone.

3. **The connection's permission set has expanded substantially since the ticket was filed.** Original ticket recorded 4 permissions: `control_charge, read_battery, read_charge, read_vehicle_info`. Current connection lists 28: `control_charge, control_climate, control_ignition, control_navigation, control_pin, control_security, control_trunk, read_alerts, read_battery, read_charge, read_charge_events, read_charge_locations, read_charge_records, read_climate, read_compass, read_diagnostics, read_extended_vehicle_info, read_location, read_odometer, read_security, read_service_history, read_speedometer, read_thermometer, read_tires, read_user_profile, read_vehicle_info, read_vin`. The most concerning grants for an unattended automation: `control_ignition`, `control_security`, `control_pin`, `control_trunk` — none needed for charge control. **Action item below** (folded into step 4).

For reference, the probe script that produced this result (kept here so the next agent can re-verify if needed):

```bash
# .env.local must have SMARTCAR_CLIENT_ID + SMARTCAR_CLIENT_SECRET
cd /Users/Eliel/Projects/Helios/app && node -e "$(cat <<'JS'
const fs = require('fs');
const env = fs.readFileSync('.env.local', 'utf-8').split('\n').reduce((a, l) => {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) a[m[1]] = m[2];
  return a;
}, {});
(async () => {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.SMARTCAR_CLIENT_ID,
    client_secret: env.SMARTCAR_CLIENT_SECRET,
  });
  const tokRes = await fetch('https://iam.smartcar.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const tok = (await tokRes.json()).access_token;
  const userId = '1fa375e5-0e19-4ff9-ab4f-d9b2cbfe91d8';
  const vid = '9c0d7a1d-d63b-47b8-bdbf-eea34cd7f969';
  for (const path of [
    '/v3/connections',
    '/v3/vehicles/' + vid,
  ]) {
    const r = await fetch('https://vehicle.api.smartcar.com' + path, {
      headers: {
        Authorization: 'Bearer ' + tok,
        'sc-user-id': userId,
        Accept: 'application/json',
      },
    });
    const txt = await r.text();
    console.log(r.status, path, '->', txt.substring(0, 400));
  }
})();
JS
)"
```

**Expected post-fix:** both return 200. The `/v3/connections` response should still list the R1S. The `/v3/vehicles/{vid}` response should now return vehicle metadata instead of `VEHICLE_NOT_FOUND`.

**If `/v3/vehicles/{vid}` is still 404:** Smartcar's fix didn't take. Reply to ticket #SS100005693 with the new request ID. Don't touch code.

**If both 200:** sync bug confirmed fixed. Move to step 2.

### Step 2 — Read the V3 signal schema docs

Before any code work, find the exact V3 endpoint shape. Three pages worth reading:

- `smartcar.com/docs/api-reference/intro` — V3 overview
- `smartcar.com/docs/api-reference/signals/schema` — list of signal groups
- `smartcar.com/docs/api-reference/signals/charge` and `signals/traction-battery` — the specific signals we need

What we need to extract:

- Exact endpoint URL (likely `/v3/signals` or `/v3/vehicles/{id}/signals`).
- HTTP method (likely POST with a body, but verify).
- Request body shape — list of requested signal names.
- Response body shape — keyed by signal name, with timestamp + value per signal.
- Specific signal names for: state-of-charge, range, charging state, plug state, charge limit. (Likely under `Charge` and `TractionBattery` groups.)

Document these in a short comment block at the top of the rewritten `app/src/lib/smartcar/client.ts` so the V3 idioms are visible to future readers.

### Step 3 — Migrate `app/src/lib/smartcar/client.ts` to V3 signals

Rewrite the V2-style data fetches:

- `getEvSnapshot()` — replace per-resource calls with a single signals request listing all needed signals.
- Charge actuators — verify whether V3 still has `start_charge` / `stop_charge` commands (likely yes, but path may differ from V2). Check `smartcar.com/docs/api-reference/commands` or equivalent.

`auth.ts` already V3 — no changes there.

`types.ts` likely needs updates to match V3 response shapes.

Add unit tests for any pure transformation logic (signal-response → `EvSnapshot`); actuator code stays at the integration boundary, untestable without network mocks.

### Step 4 — Audit Smartcar dashboard scope, then reconnect via Settings UI

**4a. Narrow the scope in the Smartcar dashboard before re-auth.** The 28-permission set on the current connection (per step 1's probe) is far broader than the charge-automation use case. The codebase's `SMARTCAR_SCOPES` constant in `app/src/lib/smartcar/auth.ts` is **informational only** — its file-header comment notes:

> *"V3 manages scope at the dashboard level (Vehicle access tab) — the authorize URL doesn't carry a `scope` param anymore."*

So the place to narrow scope is **Smartcar dashboard → Application `a4709213-b79f-468e-86af-c4221a42ba99` → Vehicle access tab**. Disable everything except:

- `control_charge`
- `read_battery`
- `read_charge`
- `read_vehicle_info`

Disable in particular: `control_ignition`, `control_security`, `control_pin`, `control_trunk`, `control_climate`, `control_navigation`. None of those are needed for charge automation, and an unattended automation shouldn't carry the authority to start the engine, change PINs, or unlock doors. After narrowing, the next user-OAuth pass will only present the user with the narrow scope, and the issued token won't carry the broader permissions.

**4b. Reconnect via Settings → Integrations.** The user's stored OAuth tokens have expired during the ticket pendency — token *refresh* won't work, the connection is gone on Smartcar's side. The existing `app/src/app/api/auth/smartcar/route.ts` flow handles a fresh Connect; it walks the user through Smartcar Connect, exchanges the code, and saves new tokens. Do this only after step 3 (V3 client migration) lands, so the new tokens have working V3 client code to consume them — and after step 4a, so the new tokens carry only the narrow scope.

### Step 5 — Re-test Helios's Smartcar code paths against the live API

Requires the car to be home and plugged in for SoC reads; charging actively for actuator tests.

In order:

1. **`getEvSnapshot()`** — confirm SoC, range, and charging state come back correctly. Compare against Rivian's GraphQL reading of the same fields for sanity.
2. **`startCharging()`** — light test only. Confirm the call returns 200 and the car responds.
3. **`stopCharging()`** — the high-stakes one. The Rivian schedule-trap incident taught us "API returns 200" is not the same as "car physically stopped." Verify on the next cron tick that `ev_w` actually drops. The `evaluateStopVerification()` helper from the v5 work (see `app/src/lib/verifyEvAction.ts`) is already wired and will catch this.
4. **Compare to Rivian's command-API stop.** If both work, document the differences (latency, reliability, side effects). If Smartcar's stop is durable where Rivian's isn't, that's a meaningful finding.

### Step 6 — Integration strategy — DECIDED 2026-05-01

**Decision: (c) parallel for stops, (b) Rivian primary for reads.**

Rationale:

- **Stops are the high-stakes path.** The 4/30 incident showed how expensive single-path stop authority is when it fails ($7+ in peak imports during the worst stretch). Two independent OEM connections, two independent code paths, two independent failure modes. Helios is fully blocked only when *both* paths fail simultaneously — meaningfully different risk profile than either alone.
- **Reads should prioritize freshness and richness over redundancy.** Rivian's GraphQL `vehicleState` is a direct OEM fetch with ~100 fields and near-real-time freshness. Smartcar V3 normalizes across brands and is gated by Smartcar's polling cadence (empirically: most signals show "Unavailable"/ERROR with stale `oemUpdatedAt` timestamps). Smartcar stays wired as a fallback so reads don't go fully dark when Rivian rate-limits or rotates auth.
- **Cost paid: complexity.** Two integrations to maintain, two activity-feed entries per stop, edge case where both succeed (charge stops twice — harmless but noisier in logs). Acceptable for a single-tenant project given the alternative cost.

What this commits us to in the codebase:

1. **Read path stays unchanged.** `status.ts` already prefers Rivian and falls back to Smartcar; the V3 read migration we just shipped slots in cleanly without behavior change.

2. **Stop path: cron's `fireEvAction` shifts from serial-fallback to parallel-fire when `action === "stop"`.** Both `rivianStopCharging` and `smartcarStopCharging` fire concurrently. Each result logs as its own activity entry. The verification loop in `lib/verifyEvAction.ts` catches the "neither worked" case via `ev_w` on the next tick. **Start path stays serial** — parallel starts would risk dueling rate budgets to the wall connector.

3. **Smartcar V3 actuator migration is now P1, not "deferred indefinitely."** Without `stopCharging` migrated to V3 commands (current code is V2-style and will throw under V3 tokens), parallel-stop has only one working leg. Step 3 of this plan must include actuator migration, not just reads.

4. **Live tests must pass independently.** Rivian v5 STOP_CHARGING smoke-tests on its own. Smartcar V3 `stopCharging` smoke-tests on its own. Then parallel-stop is real. If one path fails persistently, degrade gracefully to single-path (the one that works) and document the gap.

5. **No Settings UI toggle.** Ship parallel-stop as the default and only behavior. Add a toggle later if the activity-log noise or double-actuation edge cases get annoying — premature flexibility is its own complexity tax.

Source for this decision: 2026-05-01 session, in conversation. The 4/30 postmortem's "two paths is better than one for stops" lesson was the deciding factor.

### Step 7 — Update the integrations UI + remove the "broken" comments

Once verified working, sweep the codebase for the dead comments:

```bash
grep -rn "broken pending V3 OAuth\|V3 OAuth gap\|V3 OAuth resolution" app/src
```

Replace with current state. Re-show the Smartcar row in `IntegrationsCard.tsx`.

### Step 8 — File a small follow-up note in `app/AGENTS.md`

The ticket-and-resolution loop is itself a process artifact worth documenting. A short note: *"Smartcar V3 vehicle-data API was broken for Rivian R1S 2025 from <date> to <date>. Fixed by Smartcar after support ticket on <date>. See `docs/smartcar-integration-handoff.md` for the full reproduction and resolution."* So a future agent debugging Smartcar weirdness has a paper trail.

## Things to NOT do

- **Don't trust the fix without the live probe.** The original failure mode looked like everything was working until you hit the actual data endpoint. Run the probe in step 1.
- **Don't try to make `client.ts` work by tweaking the V2-style paths.** The whole resource-per-endpoint pattern is gone in V3. A surgical edit is the wrong shape; the file needs a signals-architecture rewrite.
- **Don't reconnect via Settings UI before the V3 client migration is done.** The new tokens will work, but the first read call will 404 until `client.ts` uses V3 paths. Migrate first, then reconnect, then test.
- **Don't enable Smartcar charge actuators automatically once reconnected.** Stop verification first. The 4/30 incident proved how expensive it is to assume "API ack = physical state."
- **Don't tear out the Rivian unofficial GraphQL code even if Smartcar is solid.** It's working today and the v5 command-API work in flight makes it more durable. Two paths is better than one for stops.
- **Don't carry forward the "Smartcar broken" comments without verification.** They're stale as soon as the V3 migration + reconnect lands.

## Related artifacts

- `app/src/lib/smartcar/auth.ts` — the V3 Connect implementation. Read the file-header comment for V2-vs-V3 history.
- `app/src/lib/smartcar/client.ts` — `getEvSnapshot`, `startCharging`, `stopCharging`.
- `app/src/lib/status.ts` — the Smartcar overlay in `assembleStatus()`.
- `app/src/app/api/cron/decide/route.ts` — `fireEvAction()` fallback path (line ~388).
- `docs/postmortems/2026-04-30-rivian-schedule-trap.md` — why having a redundant officially-supported actuator path matters.
- `docs/session-handoff.md` — current state of the Rivian command-API v5 work, including the BLE-pairing risk that Smartcar bypasses.

## Open questions for the next session

1. **What's the exact V3 signals endpoint shape?** Read `smartcar.com/docs/api-reference/signals/...` before writing client code. Need: URL, method, request body, response body, signal names for SoC / range / charging-state / plug-state / charge-limit.
2. **Do V3 commands (`start_charge`, `stop_charge`, `set_charge_limit`) keep the same path shape as V2, or did those move too?** Verify before touching `startCharging`/`stopCharging`/`setChargeLimit`.
3. Is the Smartcar sync fix specific to Rivian R1S 2025, or did they ship a broader patch? (Less critical for us; mostly informational.)
4. Does Smartcar's `stopCharging` durably halt a Rivian R1S, or does it have the same soft-pause behavior the Rivian app's Stop button has?
5. Does Smartcar's stop survive the Rivian profile-level charge-limit auto-revert (the third autonomous behavior documented in the 4/30 postmortem)?
6. If both Smartcar and Rivian command-API stops work, is there a meaningful latency difference?
