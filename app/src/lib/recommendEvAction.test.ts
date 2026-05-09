// Pins recommendEvAction's classification across the EvDecision shape.
//
// The cron route consumes this function on every tick. Two things matter:
//   1. priority="high" only when the user actually needs to act now.
//   2. signature is stable when meaning is stable — the cron uses it
//      to dedup activity-feed entries and push notifications.

import { describe, expect, it } from "vitest";
import type { EvDecision } from "./decideEvCharge";
import { recommendEvAction } from "./recommendEvAction";
import type { EnergySnapshot } from "./types";

function snap(overrides: Partial<EnergySnapshot> = {}): EnergySnapshot {
  return {
    self_sufficiency: 87,
    status_word: "Optimized",
    solar_w: 7700,
    home_w: 1400,
    ev_w: 0,
    pw_w: 0,
    grid_w: 0,
    grid_direction: "idle",
    ev_soc: 62,
    ev_target: 80,
    ev_range: 295,
    ev_charging: false,
    ev_plugged_in: true,
    ev_source: { solar: 0, grid: 0 },
    ev_charged_today_kwh: 0,
    pw_soc: 78,
    pw_reserve: 20,
    pw_mode: "Self-powered",
    tou_period: "off-peak",
    tou_rate: 0.36,
    nem_export_rate: 0.04,
    daily_cost: 0,
    week_cost: 0,
    month_cost: 0,
    daily_export_kwh: 0,
    ...overrides,
  };
}

const stop: EvDecision = {
  action: "stop",
  reason: "Sunset cutoff — protect PW for overnight",
  reasoning: [],
};

const start: EvDecision = {
  action: "start",
  reason: "Solar budget available — charge car",
  reasoning: [],
  budget_kwh: 12,
  desired_rate_kw: 7.5,
};

const hold: EvDecision = {
  action: "hold",
  reason: "Car not plugged in",
  reasoning: [],
};

describe("recommendEvAction", () => {
  describe("hold", () => {
    it("returns noop/info when engine has nothing to say", () => {
      const r = recommendEvAction({ decision: hold, snapshot: snap({ ev_plugged_in: false }) });
      expect(r.kind).toBe("noop");
      expect(r.priority).toBe("info");
      expect(r.signature).toBe("noop:hold:unplugged");
    });

    it("fires high-priority 'raise the limit' push when engine suggests it", () => {
      // Gate 2.5 case: PW full, exporting solar, EV at Rivian limit.
      // The engine returns action: hold + suggest_raise_limit because
      // it can't authorize start until the user bumps the limit.
      // recommendEvAction surfaces this as a high-priority push that's
      // distinct from the normal start/stop pattern.
      const raiseLimitDecision: EvDecision = {
        action: "hold",
        reason:
          "EV at 71% (Rivian limit 71%). Powerwall at 99%. Exporting 9.4 kW " +
          "to grid at $0.04/kWh.",
        reasoning: [],
        suggest_raise_limit: true,
      };
      const r = recommendEvAction({
        decision: raiseLimitDecision,
        snapshot: snap({
          ev_plugged_in: true,
          ev_charging: false,
          ev_w: 0,
          ev_soc: 71,
          ev_target: 71,
          pw_soc: 99,
          grid_w: -9400,
        }),
      });
      expect(r.kind).toBe("start"); // semantic: user should take an action
      expect(r.priority).toBe("high"); // user must see this
      expect(r.title).toMatch(/Raise Rivian limit/i);
      expect(r.title).toMatch(/9\.4 kW/);
      expect(r.body).toMatch(/raise limit above 71%/);
      // Signature buckets at 5% so a small SoC drift while the user
      // decides what to do doesn't re-fire identically.
      expect(r.signature).toBe("raise-limit:bucket70");
    });
  });

  describe("stop while charging", () => {
    it("priority=high with actionable body when ev_charging", () => {
      const r = recommendEvAction({
        decision: stop,
        snapshot: snap({ ev_charging: true, ev_w: 7800, ev_soc: 64 }),
      });
      expect(r.kind).toBe("stop");
      expect(r.priority).toBe("high");
      expect(r.title).toBe("Stop EV charging now");
      expect(r.body).toContain("64%");
      expect(r.body).toContain("7.8 kW");
      // 64 → 5%-bucket = 60.
      expect(r.signature).toBe("stop:high:bucket60");
    });

    it("priority=high when ev_w > 100 even if ev_charging is false", () => {
      // Tesla CT noise: contactor closed, current flowing, but the
      // ev_charging boolean flipped to false a tick early. We should
      // still recommend stop.
      const r = recommendEvAction({
        decision: stop,
        snapshot: snap({ ev_charging: false, ev_w: 5400, ev_soc: 72 }),
      });
      expect(r.priority).toBe("high");
      expect(r.kind).toBe("stop");
    });

    it("reframes as 'set Rivian charge limit' when PW is healthy (natural-limit stop)", () => {
      // 2026-05-06 18:57 PT regression — engine refused with PW at
      // 100% (well above sunset target); old framing was alarm-toned
      // "Stop EV charging now" when the situation was just "you've
      // reached today's natural budget." Reframed: tell the user
      // the limit % to set so PW lands at the sunset target.
      const naturalLimitStop: EvDecision = {
        action: "stop",
        reason: "Forecast too weak — protect Powerwall sunset target",
        reasoning: [],
        projected_end_pw_pct: 80,
      };
      const r = recommendEvAction({
        decision: naturalLimitStop,
        snapshot: snap({ ev_charging: true, ev_w: 11400, ev_soc: 63, pw_soc: 100 }),
      });
      expect(r.kind).toBe("stop");
      expect(r.priority).toBe("high"); // user still needs to act
      expect(r.title).toBe("Set Rivian charge limit to 63%");
      expect(r.body).toMatch(/Set Rivian charge limit to 63%/);
      expect(r.body).toMatch(/Powerwall at 80% by sunset/);
      expect(r.body).toMatch(/11\.4 kW/);
      // Distinct signature so the calm and alarm cases re-fire
      // independently when classification flips between them.
      expect(r.signature).toBe("stop:limit:bucket60");
    });

    it("keeps alarm framing when PW is below sunset target", () => {
      // PW at 65 (below 80 default target) → real alarm. Same
      // decision shape (Forecast too weak, projected_end_pw_pct 70),
      // but the calmer framing should NOT engage.
      const alarmStop: EvDecision = {
        action: "stop",
        reason: "Forecast too weak — protect Powerwall sunset target",
        reasoning: [],
        projected_end_pw_pct: 70,
      };
      const r = recommendEvAction({
        decision: alarmStop,
        snapshot: snap({ ev_charging: true, ev_w: 11400, ev_soc: 50, pw_soc: 65 }),
      });
      expect(r.title).toBe("Stop EV charging now");
      expect(r.body).toMatch(/Forecast too weak/);
    });

    it("signature dedups across 1% jumps (5%-bucket prevents bouncy re-fires)", () => {
      // 62 and 63 are both in bucket 60. The old per-percent signature
      // re-fired identical "Stop EV charging now" pushes 5 minutes
      // apart while the car was charging. 5% buckets preserve user-
      // meaningful re-fires (e.g. 64→65 crosses into bucket 65) while
      // killing the bouncy mid-charge ones.
      const a = recommendEvAction({
        decision: stop,
        snapshot: snap({ ev_charging: true, ev_w: 6000, ev_soc: 62 }),
      });
      const b = recommendEvAction({
        decision: stop,
        snapshot: snap({ ev_charging: true, ev_w: 6000, ev_soc: 63 }),
      });
      expect(a.signature).toBe(b.signature);

      // Crossing a bucket boundary still re-fires.
      const c = recommendEvAction({
        decision: stop,
        snapshot: snap({ ev_charging: true, ev_w: 6000, ev_soc: 65 }),
      });
      expect(c.signature).not.toBe(a.signature);
    });
  });

  describe("stop while idle", () => {
    it("priority=info — no user action needed", () => {
      const r = recommendEvAction({
        decision: stop,
        snapshot: snap({ ev_charging: false, ev_w: 0 }),
      });
      expect(r.kind).toBe("noop");
      expect(r.priority).toBe("info");
      expect(r.signature).toBe("noop:stop-but-idle");
    });

    it("treats ev_w below 100W noise threshold as idle", () => {
      const r = recommendEvAction({
        decision: stop,
        snapshot: snap({ ev_charging: false, ev_w: 75 }),
      });
      expect(r.priority).toBe("info");
    });

    it("Gate 1d 'reserve floor' alarm fires high-priority even when EV idle", () => {
      // 2026-05-09 morning regression. Overnight charging drained PW
      // past reserve floor; EV self-stopped at limit before the alarm
      // tick fired; user got no push because the old code path saw
      // ev_charging: false and demoted to info noop. But grid imports
      // at $0.36/kWh are a real ongoing cost regardless of who's
      // drawing — alarm should always be high-priority.
      const gateAlarmStop: EvDecision = {
        action: "stop",
        reason: "Powerwall at reserve floor — grid imports active",
        reasoning: [],
      };
      const r = recommendEvAction({
        decision: gateAlarmStop,
        snapshot: snap({
          ev_charging: false,
          ev_w: 0,
          pw_soc: 19,
          grid_w: 1200, // 1.2 kW grid import
        }),
      });
      expect(r.kind).toBe("stop");
      expect(r.priority).toBe("high"); // must surface, not info
      expect(r.title).toMatch(/Grid imports happening/i);
      expect(r.body).toMatch(/EV idle/i);
      expect(r.body).toMatch(/HVAC|hot tub|what's running/i);
      expect(r.signature).toMatch(/stop:floor-grid:bucket/);
    });

    it("Gate 1d alarm fires high-priority while EV is charging", () => {
      // The "EV pulling from grid" case — same alarm reason but
      // distinct title and body framing.
      const gateAlarmStop: EvDecision = {
        action: "stop",
        reason: "Powerwall at reserve floor — car charging from grid",
        reasoning: [],
      };
      const r = recommendEvAction({
        decision: gateAlarmStop,
        snapshot: snap({
          ev_charging: true,
          ev_w: 11200,
          pw_soc: 20,
          grid_w: 9700,
        }),
      });
      expect(r.priority).toBe("high");
      expect(r.title).toMatch(/Stop EV charging now/i);
      expect(r.body).toMatch(/Car drawing 11\.2 kW/i);
    });

    it("demotes 'EV at charge limit' stops to info, even while car is still drawing", () => {
      // The 2026-05-03 11:55 PT regression: Gate 3 fires when ev_soc
      // hits the Rivian limit. ev_w is still > 100W for a beat as the
      // car cuts current, but no user action is needed — the car will
      // self-stop. Old behavior fired a high-priority push asking the
      // user to set the limit to a value that was already the limit.
      const atLimitStop: EvDecision = {
        action: "stop",
        reason: "EV at 85% — at charge limit (85%)",
        reasoning: [],
      };
      const r = recommendEvAction({
        decision: atLimitStop,
        snapshot: snap({ ev_charging: true, ev_w: 11300, ev_soc: 85 }),
      });
      expect(r.kind).toBe("noop");
      expect(r.priority).toBe("info");
      expect(r.title).toMatch(/charging complete/i);
      expect(r.signature).toBe("noop:at-limit:85");
    });
  });

  describe("start while idle", () => {
    it("priority=high with action instruction in body", () => {
      // Under Option B the push body deliberately omits the rate
      // (the car ignores any rate suggestion — it draws what its OBC
      // and the cable allow). The body carries reason + action.
      const r = recommendEvAction({
        decision: start,
        snapshot: snap({ ev_charging: false, ev_w: 0 }),
      });
      expect(r.kind).toBe("start");
      expect(r.priority).toBe("high");
      expect(r.title).toBe("Start EV charging now");
      expect(r.body).not.toMatch(/\d+(\.\d+)?\s*kW/); // no rate-as-target
      expect(r.body).toMatch(/Open the Rivian app/);
      // Legacy path (no limit %): signature falls back to rate bucket.
      expect(r.signature).toBe("start:high:rate7.5");
    });

    it("includes limit % and trajectory tail when projection sets them", () => {
      // Driving-day projection populates ev_charge_limit_pct +
      // projected_*_pw_pct. The push body surfaces both: the user-
      // actionable limit % and the projected PW path through the day.
      const drivingDayStart: EvDecision = {
        action: "start",
        reason: "Driving day — charge to 70%",
        reasoning: [],
        desired_rate_kw: 11,
        ev_charge_limit_pct: 70,
        projected_departure_pw_pct: 18,
        projected_end_pw_pct: 80,
      };
      const r = recommendEvAction({
        decision: drivingDayStart,
        snapshot: snap({ ev_charging: false, ev_w: 0 }),
      });
      expect(r.body).toMatch(/set limit to 70%/);
      expect(r.body).toMatch(/drops to 18% by departure/);
      expect(r.body).toMatch(/refills to 80% by sunset/);
      // Signature now keys on limit % so the same plan re-firing is
      // deduped and a plan change re-fires.
      expect(r.signature).toBe("start:high:limit70");
    });

    it("rate signature rounds to nearest 0.5 kW (legacy path)", () => {
      const a = recommendEvAction({
        decision: { ...start, desired_rate_kw: 6.6 },
        snapshot: snap({ ev_charging: false }),
      });
      const b = recommendEvAction({
        decision: { ...start, desired_rate_kw: 6.7 },
        snapshot: snap({ ev_charging: false }),
      });
      expect(a.signature).toBe(b.signature);
      expect(a.signature).toBe("start:high:rate6.5");
    });

    it("handles missing desired_rate_kw on legacy path", () => {
      const r = recommendEvAction({
        decision: { ...start, desired_rate_kw: undefined },
        snapshot: snap({ ev_charging: false }),
      });
      expect(r.priority).toBe("high");
      expect(r.signature).toBe("start:high:rate?");
    });
  });

  describe("start while already charging", () => {
    it("priority=info, surfaces current draw and reason", () => {
      const r = recommendEvAction({
        decision: start,
        snapshot: snap({ ev_charging: true, ev_w: 7400 }),
      });
      expect(r.kind).toBe("noop");
      expect(r.priority).toBe("info");
      expect(r.body).toContain("7.4 kW");
      expect(r.body).toContain("Solar budget available");
      expect(r.signature).toBe("noop:start-and-charging");
    });
  });

  describe("rivianAppUrl", () => {
    it("is rivian:// on every recommendation", () => {
      for (const d of [stop, start, hold]) {
        const r = recommendEvAction({ decision: d, snapshot: snap() });
        expect(r.rivianAppUrl).toBe("rivian://");
      }
    });
  });
});
