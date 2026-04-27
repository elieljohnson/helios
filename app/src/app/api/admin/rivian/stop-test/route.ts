// POST /api/admin/rivian/stop-test
//
// Sends a test "stop" command to Rivian using one of two strategies,
// without going through the engine. Use this to verify whether a given
// schedule shape actually halts charging in the wild — the cron loop
// is a slow/expensive way to A/B test actuator semantics.
//
// Strategies:
//   amp0    (default) — today's weekday, now → midnight, amperage=0,
//                       enabled=true. Production stopCharging() shape.
//   offhour           — today's weekday, 03:00 → 03:01 (1-min window
//                       at 3 AM PT), amperage=6, enabled=true. The
//                       car has no permission to charge "now" because
//                       no schedule covers the current minute. Used
//                       as a fallback if Rivian rejects amperage=0.
//
// Body (JSON, optional):
//   { "strategy": "amp0" | "offhour" }
//
// Auth: Bearer CRON_SECRET. Required because this *actuates* the car.

import { setChargingSchedule } from "@/lib/rivian";
import { assembleStatus } from "@/lib/status";
import type { RivianChargingSchedule, RivianWeekDay } from "@/lib/rivian/types";

const TZ = "America/Los_Angeles";

const PT_WEEKDAYS: RivianWeekDay[] = [
  "Sunday", "Monday", "Tuesday", "Wednesday",
  "Thursday", "Friday", "Saturday",
];

function ptWeekdayAndMinutes(now: Date): { weekDay: RivianWeekDay; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const hr = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const mn = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const idx = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd] ?? 1;
  return { weekDay: PT_WEEKDAYS[idx], minutes: hr * 60 + mn };
}

function isAuthed(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;
  return req.headers.get("authorization") === `Bearer ${expected}`;
}

export async function POST(request: Request) {
  if (!isAuthed(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    strategy?: "amp0" | "offhour";
  };
  const strategy = body.strategy ?? "amp0";
  if (strategy !== "amp0" && strategy !== "offhour") {
    return Response.json({ error: `unknown strategy: ${strategy}` }, { status: 400 });
  }

  // Fetch home coords from system config.
  const status = await assembleStatus({ forEngine: true });
  const coords = status.system.coords;
  if (!coords) {
    return Response.json({ error: "no home coords in system config" }, { status: 412 });
  }

  // Vehicle ID lives in the rivian token row; setChargingSchedule reads
  // it from there too — but we need it explicitly here to call the
  // public helper. Easiest: import the same readAuth path.
  //
  // (If we ever expose a public getVehicleId helper, swap this.)
  const { getToken } = await import("@/lib/db");
  const tok = await getToken("rivian");
  if (!tok?.system_id) {
    return Response.json({ error: "no pinned vehicle" }, { status: 412 });
  }

  const now = new Date();
  const { weekDay, minutes } = ptWeekdayAndMinutes(now);

  let schedule: RivianChargingSchedule;
  if (strategy === "amp0") {
    const startTime = Math.max(0, minutes - 1);
    const duration = Math.max(1, 1440 - startTime);
    schedule = {
      weekDays: [weekDay],
      startTime,
      duration,
      location: { latitude: coords.lat, longitude: coords.lng },
      amperage: 0,
      enabled: true,
    };
  } else {
    // offhour: window at 03:00–03:01. 6A is the lowest that charging
    // hardware reliably negotiates. The point isn't to charge — it's
    // to give the car a SCHEDULE so it knows it's not allowed to
    // charge outside that window.
    schedule = {
      weekDays: [weekDay],
      startTime: 180,
      duration: 1,
      location: { latitude: coords.lat, longitude: coords.lng },
      amperage: 6,
      enabled: true,
    };
  }

  const t0 = Date.now();
  try {
    const result = await setChargingSchedule(tok.system_id, [schedule]);
    return Response.json({
      ok: true,
      strategy,
      sent_schedule: schedule,
      rivian_response: result,
      duration_ms: Date.now() - t0,
      hint: "Watch the Rivian app — the car should report 'Charge complete' or 'Scheduled' within ~30s if Rivian honored the schedule.",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[admin/rivian/stop-test ${strategy}] failed:`, err);
    return Response.json(
      {
        ok: false,
        strategy,
        sent_schedule: schedule,
        error: msg,
        duration_ms: Date.now() - t0,
      },
      { status: 500 },
    );
  }
}
