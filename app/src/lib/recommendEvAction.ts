// Pure translator: EvDecision + snapshot → user-facing recommendation.
//
// Under Option B (locked 2026-05-01), Helios doesn't actuate the EV.
// The decision engine still runs every 5 min — this function turns its
// output into something the user can act on:
//
//   { kind, priority, title, body, rivianAppUrl, signature }
//
// `kind` classifies the recommended user action: stop charging, start
// charging, or noop (current state already matches engine intent).
//
// `priority` answers "should we interrupt the user?" — `high` when the
// user needs to actuate now to match engine intent (e.g. car is charging
// during peak, or solar is surplus and the car is idle). `info` for
// everything else.
//
// `signature` is a stable string that changes only when the user-visible
// recommendation changes meaningfully. Callers (cron / activity feed)
// use it to dedup — don't re-log/re-push when last tick's signature
// matches.
//
// `rivianAppUrl` is the iOS deep-link (confirmed working 2026-05-01).
// On non-iOS the link will fall through to a Rivian web page; that's
// fine.

import type { EvDecision } from "./decideEvCharge";
import type { EnergySnapshot } from "./types";

export type EvRecommendationKind = "stop" | "start" | "noop";
export type EvRecommendationPriority = "high" | "info";

export type EvRecommendation = {
  kind: EvRecommendationKind;
  priority: EvRecommendationPriority;
  /** Short, action-oriented. ≤ 60 chars. Used for activity-feed title
   *  and push notification title. */
  title: string;
  /** 1–2 sentences. Explanation + concrete next step. Used for the
   *  activity-feed reason and the push body. */
  body: string;
  /** iOS deep-link to the Rivian app. Confirmed working on the user's
   *  device. On other platforms this either opens the Rivian web app
   *  or fails silently — both acceptable. */
  rivianAppUrl: string;
  /** Stable string. Changes when the user-visible meaning changes. */
  signature: string;
};

const RIVIAN_APP_URL = "rivian://";

/** EV is "actively drawing current" if either flag from the snapshot
 *  agrees. Tesla CT noise sometimes shows ev_w > 0 when ev_charging is
 *  false (and vice versa); take the OR for the "currently charging"
 *  test so we don't miss either edge. 100W threshold matches the
 *  long-standing Helios convention (was VERIFY_DRAW_THRESHOLD_W). */
function isCurrentlyCharging(snapshot: EnergySnapshot): boolean {
  return snapshot.ev_charging || snapshot.ev_w > 100;
}

export function recommendEvAction(opts: {
  decision: EvDecision;
  snapshot: EnergySnapshot;
}): EvRecommendation {
  const { decision, snapshot } = opts;
  const charging = isCurrentlyCharging(snapshot);

  // hold = engine has nothing to say (e.g. car not plugged in). Always
  // a noop recommendation — the user has no required action.
  if (decision.action === "hold") {
    return {
      kind: "noop",
      priority: "info",
      title: "EV charging — no action needed",
      body: decision.reason,
      rivianAppUrl: RIVIAN_APP_URL,
      signature: `noop:hold:${snapshot.ev_plugged_in ? "plugged" : "unplugged"}`,
    };
  }

  if (decision.action === "stop") {
    // High priority only if the car is actually drawing right now.
    // Stop-while-already-stopped → info (good, no user action).
    if (charging) {
      const drawKw = (snapshot.ev_w / 1000).toFixed(1);
      return {
        kind: "stop",
        priority: "high",
        title: "Stop EV charging now",
        body:
          `${decision.reason}. Car is currently drawing ${drawKw} kW. ` +
          `Open the Rivian app → Charging → set the limit to ${snapshot.ev_soc}%, ` +
          `or unplug.`,
        rivianAppUrl: RIVIAN_APP_URL,
        // Signature includes SoC so a 1% jump (which would shift the
        // suggested limit) re-fires the recommendation.
        signature: `stop:high:soc${snapshot.ev_soc}`,
      };
    }
    return {
      kind: "noop",
      priority: "info",
      title: "EV idle — engine recommends stop",
      body: decision.reason,
      rivianAppUrl: RIVIAN_APP_URL,
      signature: `noop:stop-but-idle`,
    };
  }

  // decision.action === "start"
  const rateKw = decision.desired_rate_kw;
  const rateLabel = rateKw ? ` at ~${rateKw} kW` : "";

  if (!charging) {
    return {
      kind: "start",
      priority: "high",
      title: "Start EV charging now",
      body:
        `${decision.reason}${rateLabel}. ` +
        `Open the Rivian app → Charging → Start, or plug-and-play if already connected.`,
      rivianAppUrl: RIVIAN_APP_URL,
      // Signature ignores tiny rate jitter — round to nearest 0.5 kW.
      signature: `start:high:rate${rateKw ? Math.round(rateKw * 2) / 2 : "?"}`,
    };
  }

  // Already charging — no high-priority action needed. The body still
  // surfaces the engine-suggested rate so the user can compare against
  // what the car is actually drawing.
  const currentRateKw = (snapshot.ev_w / 1000).toFixed(1);
  return {
    kind: "noop",
    priority: "info",
    title: "EV charging — engine in sync",
    body:
      `Car drawing ${currentRateKw} kW; engine target${rateLabel}. ` +
      `${decision.reason}`,
    rivianAppUrl: RIVIAN_APP_URL,
    signature: `noop:start-and-charging`,
  };
}
