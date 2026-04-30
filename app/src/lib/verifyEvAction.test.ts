import { describe, expect, it } from "vitest";
import {
  evaluateStopVerification,
  VERIFY_DRAW_THRESHOLD_W,
  VERIFY_MAX_SECONDS,
  VERIFY_MIN_SECONDS,
} from "./verifyEvAction";
import type { ActionEntry } from "./types";

const NOW = new Date("2026-05-01T18:00:00.000Z");

function action(opts: Partial<ActionEntry> & Pick<ActionEntry, "title" | "ok">): ActionEntry {
  return {
    timestamp: opts.timestamp ?? NOW.toISOString(),
    display_time: opts.display_time ?? "11:00",
    type: opts.type ?? "charge",
    title: opts.title,
    reason: opts.reason ?? "test",
    ok: opts.ok,
    target_value: opts.target_value ?? null,
    prev_value: opts.prev_value ?? null,
  };
}

function secondsAgo(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1000).toISOString();
}

describe("evaluateStopVerification", () => {
  it("returns no-recent-stop when there are no actions", () => {
    const result = evaluateStopVerification({
      recentActions: [],
      currentEvW: 11_000,
      now: NOW,
    });
    expect(result.kind).toBe("no-recent-stop");
  });

  it("returns no-recent-stop when the recent actions are all reserve actions", () => {
    const result = evaluateStopVerification({
      recentActions: [
        action({ type: "reserve", title: "Set reserve 20%", ok: true, timestamp: secondsAgo(120) }),
      ],
      currentEvW: 11_000,
      now: NOW,
    });
    expect(result.kind).toBe("no-recent-stop");
  });

  it("returns too-soon when the stop is younger than VERIFY_MIN_SECONDS", () => {
    const result = evaluateStopVerification({
      recentActions: [
        action({
          title: "Stop EV charge",
          ok: true,
          timestamp: secondsAgo(VERIFY_MIN_SECONDS - 5),
        }),
      ],
      currentEvW: 11_000,
      now: NOW,
    });
    expect(result.kind).toBe("too-soon");
  });

  it("returns stale when the stop is older than VERIFY_MAX_SECONDS", () => {
    const result = evaluateStopVerification({
      recentActions: [
        action({
          title: "Stop EV charge",
          ok: true,
          timestamp: secondsAgo(VERIFY_MAX_SECONDS + 5),
        }),
      ],
      currentEvW: 11_000,
      now: NOW,
    });
    expect(result.kind).toBe("stale");
  });

  it("returns ok when the stop is in-window and ev_w is below threshold", () => {
    const result = evaluateStopVerification({
      recentActions: [
        action({
          title: "Stop EV charge",
          ok: true,
          timestamp: secondsAgo(180),
        }),
      ],
      currentEvW: VERIFY_DRAW_THRESHOLD_W - 1,
      now: NOW,
    });
    expect(result.kind).toBe("ok");
  });

  it("returns failed when the stop is in-window and ev_w is still drawing", () => {
    const result = evaluateStopVerification({
      recentActions: [
        action({
          title: "Stop EV charge",
          ok: true,
          timestamp: secondsAgo(180),
        }),
      ],
      currentEvW: 11_000,
      now: NOW,
    });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.currentEvW).toBe(11_000);
      expect(result.message).toMatch(/still drawing 11\.0 kW/);
    }
  });

  it("ignores write-failed stop actions (those weren't real stops)", () => {
    const result = evaluateStopVerification({
      recentActions: [
        action({
          title: "Stop EV charge (write failed)",
          ok: false,
          timestamp: secondsAgo(180),
        }),
      ],
      currentEvW: 11_000,
      now: NOW,
    });
    expect(result.kind).toBe("no-recent-stop");
  });

  it("returns already-flagged when the most recent action is already a verification failure", () => {
    const result = evaluateStopVerification({
      recentActions: [
        action({
          title: "Stop EV charge — verification failed",
          ok: false,
          timestamp: secondsAgo(60),
        }),
        action({
          title: "Stop EV charge",
          ok: true,
          timestamp: secondsAgo(180),
        }),
      ],
      currentEvW: 11_000,
      now: NOW,
    });
    expect(result.kind).toBe("already-flagged");
  });

  it("verifies the most recent stop, not older ones", () => {
    // Old stop (out-of-window) followed by a fresh stop in-window.
    // The fresh one should be the one verified.
    const result = evaluateStopVerification({
      recentActions: [
        action({
          title: "Stop EV charge",
          ok: true,
          timestamp: secondsAgo(120),
        }),
        action({
          title: "Stop EV charge",
          ok: true,
          timestamp: secondsAgo(VERIFY_MAX_SECONDS + 100),
        }),
      ],
      currentEvW: 11_000,
      now: NOW,
    });
    expect(result.kind).toBe("failed");
  });

  it("voids verification when a start action fired after the stop", () => {
    // Engine flipped its mind: stopped, then started. Drawing current
    // is now expected — there's nothing to verify.
    const result = evaluateStopVerification({
      recentActions: [
        action({
          title: "Start EV charge at 9 kW",
          ok: true,
          timestamp: secondsAgo(60),
        }),
        action({
          title: "Stop EV charge",
          ok: true,
          timestamp: secondsAgo(180),
        }),
      ],
      currentEvW: 11_000,
      now: NOW,
    });
    expect(result.kind).toBe("no-recent-stop");
  });

  it("voids verification when an update (mid-charge rate change) fired after the stop", () => {
    const result = evaluateStopVerification({
      recentActions: [
        action({
          title: "Update EV charge at 7 kW",
          ok: true,
          timestamp: secondsAgo(60),
        }),
        action({
          title: "Stop EV charge",
          ok: true,
          timestamp: secondsAgo(180),
        }),
      ],
      currentEvW: 7_000,
      now: NOW,
    });
    expect(result.kind).toBe("no-recent-stop");
  });
});
