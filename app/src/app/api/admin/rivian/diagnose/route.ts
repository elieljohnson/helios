// GET /api/admin/rivian/diagnose
//
// Read-only diagnostic. Pulls fresh vehicleState from Rivian and
// returns the fields Helios uses, so we can verify what the engine
// actually sees on a given tick.
//
// Auth: Bearer CRON_SECRET (same secret the Vercel cron uses; if it's
// unset — i.e. local dev — the check is skipped).

import { getEvSnapshot, isConfigured } from "@/lib/rivian";
import { assembleStatus } from "@/lib/status";

function isAuthed(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return true; // local dev / unset
  return req.headers.get("authorization") === `Bearer ${expected}`;
}

export async function GET(request: Request) {
  if (!isAuthed(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const t0 = Date.now();
  try {
    if (!(await isConfigured())) {
      return Response.json({ error: "Rivian not configured" }, { status: 412 });
    }

    // 1) Direct Rivian read — what the actuator sees.
    const ev = await getEvSnapshot();

    // 2) Composed snapshot — what the engine sees. Mirrors the cron
    //    path (forEngine: true skips Enphase) so this matches the
    //    cron tick's view of the world byte-for-byte.
    const status = await assembleStatus({ forEngine: true });

    return Response.json({
      ok: true,
      duration_ms: Date.now() - t0,
      rivian_direct: ev,
      engine_view: {
        ev_soc: status.snapshot.ev_soc,
        ev_w: status.snapshot.ev_w,
        ev_charging: status.snapshot.ev_charging,
        ev_plugged_in: status.snapshot.ev_plugged_in,
        ev_target: status.snapshot.ev_target,
        pw_soc: status.snapshot.pw_soc,
        pw_w: status.snapshot.pw_w,
        solar_w: status.snapshot.solar_w,
        home_w: status.snapshot.home_w,
        sources: status.sources,
        coords: status.system.coords,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[admin/rivian/diagnose] failed:", err);
    return Response.json(
      { ok: false, duration_ms: Date.now() - t0, error: msg },
      { status: 500 },
    );
  }
}
