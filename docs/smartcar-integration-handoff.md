# Smartcar integration — handoff

**Status (2026-05-01):** Smartcar support reports that the V3 vehicle-data API issue we filed against Rivian R1S 2025 is **fixed**. Verification not yet done. Helios's Smartcar integration code is intact and reachable via the Settings → Integrations panel; it's been dormant since the V3 break.

This file is for the next agent picking up the verification + reintegration work.

## TL;DR

- Built a full Smartcar integration in early April 2026 covering OAuth, vehicle pinning, EV-state read, and charge start/stop.
- Worked under V2 OAuth. **Broke when Smartcar migrated to V3** mid-build — Rivian dropped from their compatibility list, then partially returned in a state where the `/v3/connections` endpoint listed the vehicle but `/v3/vehicles/{vehicle_id}` returned 404.
- Filed a support ticket against Smartcar with full reproduction.
- Kept the integration code in place behind a `Smartcar broken pending V3 OAuth resolution` comment so re-enabling is one ticket reply away.
- Smartcar replied saying the issue is fixed. Time to verify and decide how Smartcar fits alongside the unofficial Rivian GraphQL integration.

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

### Step 1 — Verify the fix

Before any code work. Run the same probes that failed before. M2M client_credentials flow, hit the V3 vehicle endpoint, see what it returns now.

```bash
# .env.local must have SMARTCAR_CLIENT_ID + SMARTCAR_CLIENT_SECRET
node -e "$(cat <<'JS'
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
    '/v3/vehicles/' + vid + '/battery',
    '/v3/vehicles/' + vid + '/charge',
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

Expected (post-fix): all four return 200 with vehicle/battery/charge data.

If still broken: stop, re-open the Smartcar ticket with the new sample request IDs, do not touch code.

### Step 2 — Reconnect via the Settings UI

If the M2M probe works, the user's stored tokens are stale. Reconnect Smartcar via Settings → Integrations to mint fresh user-level OAuth tokens. The existing `app/src/app/api/auth/smartcar/route.ts` flow handles this.

### Step 3 — Re-test Helios's own Smartcar code paths against the live API

In rough order:

1. **`getEvSnapshot()`** — confirm SoC, range, and charging state come back correctly. Compare against Rivian's GraphQL reading of the same fields for sanity.
2. **`startCharging()`** — light test only. Confirm the call returns 200 and the car responds.
3. **`stopCharging()`** — the high-stakes one. The Rivian schedule-trap incident taught us that "API returns 200" is not the same as "car physically stopped." Verify on the next cron tick that `ev_w` actually drops. Use the `evaluateStopVerification()` helper from the v5 work (see `app/src/lib/verifyEvAction.ts`) if it's already wired by the next session.
4. **Compare to Rivian's command-API stop.** If both work, document the differences (latency, reliability, side effects). If Smartcar's stop is durable where Rivian's isn't, that's a meaningful finding.

### Step 4 — Decide the integration strategy

Open question with at least three reasonable answers:

**(a) Smartcar primary, Rivian unofficial GraphQL as fallback.** Officially-supported APIs are more durable; Rivian unofficial is at the mercy of any iOS/Android app update. Pro: stability. Con: Smartcar costs ~$10/vehicle/month at scale, and they've already burned us once with V3.

**(b) Rivian primary, Smartcar as fallback.** What we've effectively been running. Pro: zero ongoing cost. Con: fragile (the v5 work is non-trivial; phone-key enrollment is a maintenance burden).

**(c) Both wired in parallel for redundancy.** Belt-and-suspenders for stops specifically. Cron's `fireEvAction` already has the fallback chain; could be extended to "fire both on stop, succeed if either physically halts the car." Pro: maximum stop authority. Con: complexity, possible double-actuation edge cases.

The 2026-04-30 lessons argue for (c) on stops specifically and (a) or (b) on reads. Worth a structured decision before re-enabling, not just defaulting to whatever's easiest.

### Step 5 — Update the integrations UI + remove the "broken" comments

Once verified working, sweep the codebase for the dead comments:

```bash
grep -rn "broken pending V3 OAuth\|V3 OAuth gap\|V3 OAuth resolution" app/src
```

Replace with current state. Re-show the Smartcar row in `IntegrationsCard.tsx`.

### Step 6 — File a small follow-up note in `app/AGENTS.md`

The ticket-and-resolution loop is itself a process artifact worth documenting. A short note: *"Smartcar V3 vehicle-data API was broken for Rivian R1S 2025 from <date> to <date>. Fixed by Smartcar after support ticket on <date>. See `docs/smartcar-integration-handoff.md` for the full reproduction and resolution."* So a future agent debugging Smartcar weirdness has a paper trail.

## Things to NOT do

- **Don't trust the fix without the live probe.** The original failure mode looked like everything was working until you hit the actual data endpoint. Run the probe in step 1.
- **Don't enable Smartcar charge actuators automatically once reconnected.** Stop verification first. The 4/30 incident proved how expensive it is to assume "API ack = physical state."
- **Don't tear out the Rivian unofficial GraphQL code even if Smartcar is solid.** It's working today and the v5 command-API work in flight makes it more durable. Two paths is better than one for stops.
- **Don't carry forward the "Smartcar broken" comments without verification.** They're stale as soon as step 1 passes.

## Related artifacts

- `app/src/lib/smartcar/auth.ts` — the V3 Connect implementation. Read the file-header comment for V2-vs-V3 history.
- `app/src/lib/smartcar/client.ts` — `getEvSnapshot`, `startCharging`, `stopCharging`.
- `app/src/lib/status.ts` — the Smartcar overlay in `assembleStatus()`.
- `app/src/app/api/cron/decide/route.ts` — `fireEvAction()` fallback path (line ~388).
- `docs/postmortems/2026-04-30-rivian-schedule-trap.md` — why having a redundant officially-supported actuator path matters.
- `docs/session-handoff.md` — current state of the Rivian command-API v5 work, including the BLE-pairing risk that Smartcar bypasses.

## Open questions for the next session

1. Is the Smartcar fix specific to Rivian R1S 2025, or did they ship a broader V3 patch?
2. What's Smartcar's current Rivian compatibility matrix — did they re-add the model lineup or just our specific car?
3. Does Smartcar's `stopCharging` durably halt a Rivian R1S, or does it have the same soft-pause behavior the Rivian app's Stop button has?
4. Does Smartcar's stop survive the Rivian profile-level charge-limit auto-revert (the third autonomous behavior documented in the 4/30 postmortem)?
5. If both Smartcar and Rivian command-API stops work, is there a meaningful latency difference?
