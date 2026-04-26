// Diagnostic: figure out the right "stop charging" payload shape.
// Empty array gave us "Bad request error" — try single-disabled and
// other shapes, dump full response bodies for each.
//
//   node --env-file=.env.local --import tsx scripts/rivian-stop-probe.ts

import { getToken } from "../src/lib/db";
import {
  RIVIAN_CLIENT_NAME,
  RIVIAN_GATEWAY_URL,
  RIVIAN_USER_AGENT,
  SET_CHARGING_SCHEDULES_MUTATION,
} from "../src/lib/rivian/auth";

const HOME_COORDS = { latitude: 37.897029, longitude: -122.539091 };

void (async () => {
  const tok = await getToken("rivian");
  if (!tok) throw new Error("no rivian token");
  const meta = tok.meta as { csrf_token: string; a_sess: string };
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "apollographql-client-name": RIVIAN_CLIENT_NAME,
    "user-agent": RIVIAN_USER_AGENT,
    "a-sess": meta.a_sess,
    "u-sess": tok.access_token,
    "csrf-token": meta.csrf_token,
  };
  const vehicleId = tok.system_id!;
  console.log(`vehicle: ${vehicleId}\n`);

  const probe = async (label: string, schedules: unknown[]) => {
    console.log(`--- ${label} ---`);
    console.log(`  payload: ${JSON.stringify(schedules)}`);
    const r = await fetch(RIVIAN_GATEWAY_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        operationName: "SetChargingSchedule",
        query: SET_CHARGING_SCHEDULES_MUTATION,
        variables: { vehicleId, chargingSchedules: schedules },
      }),
    });
    const text = await r.text();
    console.log(`  HTTP ${r.status}`);
    console.log(`  body: ${text.slice(0, 500)}`);
    console.log();
  };

  // Variant 1: empty array (already known to fail; baseline)
  await probe("empty array", []);

  // Variant 2: single schedule, enabled: false, today, 0-duration
  const today = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
  }).format(new Date());
  await probe("single disabled, today, 0 duration", [
    {
      weekDays: [today],
      startTime: 0,
      duration: 0,
      location: HOME_COORDS,
      amperage: 0,
      enabled: false,
    },
  ]);

  // Variant 3: single disabled, all weekdays, valid amperage
  await probe("single disabled, all days, 6A 60min", [
    {
      weekDays: ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"],
      startTime: 0,
      duration: 60,
      location: HOME_COORDS,
      amperage: 6,
      enabled: false,
    },
  ]);

  // Variant 4: single ENABLED but tiny (effectively no-op since car
  // would have to be at home AND time matches)
  await probe("single enabled, today, 1A 1min in past", [
    {
      weekDays: [today],
      startTime: 0,
      duration: 1,
      location: HOME_COORDS,
      amperage: 6,
      enabled: true,
    },
  ]);
})();
