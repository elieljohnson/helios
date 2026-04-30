import { describe, expect, it } from "vitest";
import { signalsToEvSnapshot } from "./transform";
import type { SmartcarV3Signal } from "./types";

const INFO = { vehicleId: "vid-1", make: "RIVIAN", model: "R1S" };

/** Build a plausible signal envelope. Defaults to status=ERROR because
 *  that's the empirically-observed normal — V3's "stale but cached" mode. */
function sig<T>(code: string, body: T, status: "SUCCESS" | "ERROR" = "ERROR"): SmartcarV3Signal {
  return {
    id: code,
    type: "signal",
    attributes: {
      code,
      name: code,
      group: code.split("-")[0] ?? "",
      status: { value: status },
      body,
    },
  };
}

describe("signalsToEvSnapshot", () => {
  it("projects a fully-populated signal array onto the snapshot shape (km→mi conversion)", () => {
    const result = signalsToEvSnapshot({
      info: INFO,
      signals: [
        sig("tractionbattery-stateofcharge", { value: 35, unit: "percent" }),
        sig("tractionbattery-range", { value: 173, unit: "km" }),
        sig("charge-ischarging", { value: false }),
        sig("charge-ischargingcableconnected", { value: true }),
      ],
    });
    expect(result).toEqual({
      vehicleId: "vid-1",
      make: "RIVIAN",
      model: "R1S",
      soc: 35,
      rangeMiles: 107, // 173 km / 1.609344 = 107.49 → 107
      isCharging: false,
      isPluggedIn: true,
    });
  });

  it("treats ERROR status as best-effort — uses body value if present", () => {
    // All ERROR — empirically the normal case from the discovery probe.
    const result = signalsToEvSnapshot({
      info: INFO,
      signals: [
        sig("tractionbattery-stateofcharge", { value: 80 }, "ERROR"),
        sig("tractionbattery-range", { value: 322, unit: "km" }, "ERROR"),
        sig("charge-ischarging", { value: true }, "ERROR"),
        sig("charge-ischargingcableconnected", { value: true }, "ERROR"),
      ],
    });
    expect(result).not.toBeNull();
    expect(result?.soc).toBe(80);
    expect(result?.isCharging).toBe(true);
  });

  it("does NOT convert when range body declares unit:'mi'", () => {
    const result = signalsToEvSnapshot({
      info: INFO,
      signals: [
        sig("tractionbattery-stateofcharge", { value: 50 }),
        sig("tractionbattery-range", { value: 200, unit: "mi" }),
        sig("charge-ischarging", { value: false }),
        sig("charge-ischargingcableconnected", { value: false }),
      ],
    });
    expect(result?.rangeMiles).toBe(200);
  });

  it("defaults to km→mi conversion when unit is unspecified (V3 default is metric)", () => {
    const result = signalsToEvSnapshot({
      info: INFO,
      signals: [
        sig("tractionbattery-stateofcharge", { value: 50 }),
        sig("tractionbattery-range", { value: 100 }), // no unit field
        sig("charge-ischarging", { value: false }),
        sig("charge-ischargingcableconnected", { value: false }),
      ],
    });
    // Treats as km: 100 / 1.609 = 62.14 → 62
    expect(result?.rangeMiles).toBe(62);
  });

  it("returns null when SoC signal is missing entirely", () => {
    const result = signalsToEvSnapshot({
      info: INFO,
      signals: [
        sig("tractionbattery-range", { value: 173, unit: "km" }),
        sig("charge-ischarging", { value: false }),
        sig("charge-ischargingcableconnected", { value: true }),
      ],
    });
    expect(result).toBeNull();
  });

  it("returns null when SoC body is empty (refresh failed AND no cache)", () => {
    const result = signalsToEvSnapshot({
      info: INFO,
      signals: [
        sig("tractionbattery-stateofcharge", undefined),
        sig("tractionbattery-range", { value: 173, unit: "km" }),
        sig("charge-ischarging", { value: false }),
        sig("charge-ischargingcableconnected", { value: true }),
      ],
    });
    expect(result).toBeNull();
  });

  it("returns null when isCharging signal is missing", () => {
    const result = signalsToEvSnapshot({
      info: INFO,
      signals: [
        sig("tractionbattery-stateofcharge", { value: 50 }),
        sig("tractionbattery-range", { value: 200, unit: "mi" }),
        sig("charge-ischargingcableconnected", { value: true }),
      ],
    });
    expect(result).toBeNull();
  });

  it("returns null when cable-connected signal is missing", () => {
    const result = signalsToEvSnapshot({
      info: INFO,
      signals: [
        sig("tractionbattery-stateofcharge", { value: 50 }),
        sig("tractionbattery-range", { value: 200, unit: "mi" }),
        sig("charge-ischarging", { value: false }),
      ],
    });
    expect(result).toBeNull();
  });

  it("ignores extra signals beyond the four it cares about (real probes return 20+)", () => {
    const result = signalsToEvSnapshot({
      info: INFO,
      signals: [
        sig("tractionbattery-stateofcharge", { value: 35 }),
        sig("tractionbattery-range", { value: 173, unit: "km" }),
        sig("charge-ischarging", { value: false }),
        sig("charge-ischargingcableconnected", { value: true }),
        sig("odometer-traveleddistance", { value: 12000, unit: "km" }),
        sig("transmission-drivemode", { canonical: "NORMAL", oemDisplayName: "everyday" }),
        sig("closure-doors", undefined),
      ],
    });
    expect(result?.soc).toBe(35);
  });

  it("rounds non-integer SoC values down (Smartcar reports floats)", () => {
    const result = signalsToEvSnapshot({
      info: INFO,
      signals: [
        sig("tractionbattery-stateofcharge", { value: 35.7 }),
        sig("tractionbattery-range", { value: 173, unit: "km" }),
        sig("charge-ischarging", { value: false }),
        sig("charge-ischargingcableconnected", { value: true }),
      ],
    });
    expect(result?.soc).toBe(36); // Math.round(35.7) = 36
  });

  it("treats truthy-but-non-true isCharging values as not charging (defensive bool coercion)", () => {
    // Belt-and-suspenders: if Smartcar ever returns a string, we don't
    // want a truthy non-bool to be read as charging.
    const result = signalsToEvSnapshot({
      info: INFO,
      signals: [
        sig("tractionbattery-stateofcharge", { value: 50 }),
        sig("tractionbattery-range", { value: 200, unit: "mi" }),
        sig("charge-ischarging", { value: "yes" as unknown as boolean }),
        sig("charge-ischargingcableconnected", { value: true }),
      ],
    });
    expect(result?.isCharging).toBe(false);
  });
});
