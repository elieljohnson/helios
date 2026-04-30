// Post-stop verification — pure function.
//
// Per the 2026-04-30 postmortem (lesson #3): Rivian's API returning
// success: true means the cloud accepted the request, NOT that the
// car physically stopped drawing current. The cron route calls this
// function once per tick; if the most recent stop action looks like
// it failed in the physical world, we log a discrepancy so the user
// (and the activity log) sees an honest "stop attempted, car still
// charging" signal — without trusting any specific failure mode.
//
// Pure function so the cron-route branch stays trivial and the
// time-window logic is unit-testable without mocking the database.

import type { ActionEntry } from "./types";

/** Tunables. The cron tick is 5 min; we want the verification window
 *  to start just after the tick that fired the stop and end before
 *  enough ticks have passed that we'd already have re-fired stop
 *  through the normal decision path. */
export const VERIFY_MIN_SECONDS = 60;
export const VERIFY_MAX_SECONDS = 600;
/** Above this threshold the car is "still drawing." 100 W catches
 *  contactor-still-closed but margin against Tesla CT noise. Real
 *  charging is multi-kW, so any threshold under ~500W is equivalent. */
export const VERIFY_DRAW_THRESHOLD_W = 100;

export type StopVerificationResult =
  | { kind: "ok" }
  | { kind: "no-recent-stop" }
  | { kind: "too-soon"; secondsSinceStop: number }
  | { kind: "stale"; secondsSinceStop: number }
  | { kind: "already-flagged" }
  | {
      kind: "failed";
      stopTimestamp: string;
      secondsSinceStop: number;
      currentEvW: number;
      message: string;
    };

/** Inspect the most recent actions and decide whether to log a
 *  verification failure for the most recent stop.
 *
 *  Returns one of:
 *    - "ok" — most recent stop succeeded (ev_w below threshold) within
 *      the verification window.
 *    - "no-recent-stop" / "too-soon" / "stale" — nothing to verify.
 *    - "already-flagged" — we already logged a verification failure
 *      for this stop; don't re-log on subsequent ticks.
 *    - "failed" — caller should append an action with the message.
 *
 *  Identifies a "stop action" by matching ok=true charge actions whose
 *  title starts with "Stop EV charge". The "(write failed)" suffix
 *  variant is filtered out because those weren't real stops to verify
 *  in the first place. */
export function evaluateStopVerification(opts: {
  recentActions: ActionEntry[];
  currentEvW: number;
  now: Date;
}): StopVerificationResult {
  const { recentActions, currentEvW, now } = opts;

  // Walk backwards from newest. The first stop we hit is "the stop to
  // verify"; any verification-failure or fresh start encountered first
  // means there's nothing to verify.
  for (const a of recentActions) {
    if (a.type !== "charge") continue;

    if (isVerificationFailureAction(a)) {
      // We already flagged a verification failure more recently than
      // any successful stop. Don't re-flag.
      return { kind: "already-flagged" };
    }

    if (isSuccessfulStartAction(a)) {
      // The engine restarted charging after the stop. Whatever the
      // stop did is moot — drawing current is now expected.
      return { kind: "no-recent-stop" };
    }

    if (isSuccessfulStopAction(a)) {
      const secondsSinceStop =
        (now.getTime() - new Date(a.timestamp).getTime()) / 1000;
      if (secondsSinceStop < VERIFY_MIN_SECONDS) {
        return { kind: "too-soon", secondsSinceStop };
      }
      if (secondsSinceStop > VERIFY_MAX_SECONDS) {
        return { kind: "stale", secondsSinceStop };
      }
      if (currentEvW < VERIFY_DRAW_THRESHOLD_W) {
        return { kind: "ok" };
      }
      const drawKw = (currentEvW / 1000).toFixed(1);
      return {
        kind: "failed",
        stopTimestamp: a.timestamp,
        secondsSinceStop,
        currentEvW,
        message: `stop ack'd ${Math.round(secondsSinceStop)}s ago but car still drawing ${drawKw} kW — likely actuator-state mismatch`,
      };
    }
  }
  return { kind: "no-recent-stop" };
}

function isSuccessfulStopAction(a: ActionEntry): boolean {
  return (
    a.type === "charge" &&
    a.ok === true &&
    a.title.startsWith("Stop EV charge") &&
    !a.title.includes("(write failed)") &&
    !a.title.includes("verification failed")
  );
}

function isSuccessfulStartAction(a: ActionEntry): boolean {
  return (
    a.type === "charge" &&
    a.ok === true &&
    (a.title.startsWith("Start EV charge") || a.title.startsWith("Update EV charge")) &&
    !a.title.includes("(write failed)")
  );
}

function isVerificationFailureAction(a: ActionEntry): boolean {
  return a.type === "charge" && a.title.includes("verification failed");
}
