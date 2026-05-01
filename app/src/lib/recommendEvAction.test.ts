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
    it("priority=high with rate in body", () => {
      const r = recommendEvAction({
        decision: start,
        snapshot: snap({ ev_charging: false, ev_w: 0 }),
      });
      expect(r.kind).toBe("start");
      expect(r.priority).toBe("high");
      expect(r.title).toBe("Start EV charging now");
      expect(r.body).toContain("7.5 kW");
      // 7.5 → round to nearest 0.5 → 7.5 → signature stays steady
      expect(r.signature).toBe("start:high:rate7.5");
    });

    it("rate signature rounds to nearest 0.5 kW", () => {
      const a = recommendEvAction({
        decision: { ...start, desired_rate_kw: 6.6 },
        snapshot: snap({ ev_charging: false }),
      });
      const b = recommendEvAction({
        decision: { ...start, desired_rate_kw: 6.7 },
        snapshot: snap({ ev_charging: false }),
      });
      // 6.6 * 2 = 13.2 → 13 / 2 = 6.5; 6.7 * 2 = 13.4 → 13 / 2 = 6.5.
      // Both round into the same bucket so the signature is stable.
      expect(a.signature).toBe(b.signature);
      expect(a.signature).toBe("start:high:rate6.5");
    });

    it("handles missing desired_rate_kw", () => {
      const r = recommendEvAction({
        decision: { ...start, desired_rate_kw: undefined },
        snapshot: snap({ ev_charging: false }),
      });
      expect(r.priority).toBe("high");
      expect(r.signature).toBe("start:high:rate?");
    });
  });

  describe("start while already charging", () => {
    it("priority=info, surfaces both current and target rate", () => {
      const r = recommendEvAction({
        decision: start,
        snapshot: snap({ ev_charging: true, ev_w: 7400 }),
      });
      expect(r.kind).toBe("noop");
      expect(r.priority).toBe("info");
      expect(r.body).toContain("7.4 kW");
      expect(r.body).toContain("7.5 kW");
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
