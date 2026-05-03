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
      expect(r.signature).toBe("stop:high:soc64");
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

    it("signature changes with SoC so a 1% jump re-fires", () => {
      const a = recommendEvAction({
        decision: stop,
        snapshot: snap({ ev_charging: true, ev_w: 6000, ev_soc: 62 }),
      });
      const b = recommendEvAction({
        decision: stop,
        snapshot: snap({ ev_charging: true, ev_w: 6000, ev_soc: 63 }),
      });
      expect(a.signature).not.toBe(b.signature);
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
