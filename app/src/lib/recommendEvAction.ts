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
    // Special case: engine recommends stop because the EV reached
    // its user-set Rivian charge limit. The car self-stops at this
    // SoC — no user action is required. Observed live 2026-05-03
    // 11:55 PT: car hit 85% (its set limit), Gate 3 fired stop, the
    // recommendation was high-priority and the body asked the user
    // to "set the limit to 85%" (which was already the limit). The
    // push interrupted for nothing. Demote to info, change the
    // language from "stop now" to "charging complete," and let the
    // signature dedup keep the activity feed clean.
    if (/at charge limit/i.test(decision.reason)) {
      return {
        kind: "noop",
        priority: "info",
        title: `EV reached ${snapshot.ev_soc}% — charging complete`,
        body: decision.reason,
        rivianAppUrl: RIVIAN_APP_URL,
        signature: `noop:at-limit:${snapshot.ev_soc}`,
      };
    }
    // High priority only if the car is actually drawing right now.
    // Stop-while-already-stopped → info (good, no user action).
    if (charging) {
      const drawKw = (snapshot.ev_w / 1000).toFixed(1);
      // Bucket the SoC at 5% intervals for the stop signature.
      // Charging at 11 kW × 5 min adds ~0.7%, so the per-percent
      // signature was rolling boundary every 1–2 ticks and re-firing
      // identical "Stop EV charging now" pushes (observed live
      // 2026-05-04 07:30 + 07:35 PT — same reason, both pushed).
      // 5% buckets preserve "user-meaningful change re-fires" while
      // killing the bouncy mid-charge re-fires.
      const bucket = Math.floor(snapshot.ev_soc / 5) * 5;
      return {
        kind: "stop",
        priority: "high",
        title: "Stop EV charging now",
        body:
          `${decision.reason}. Car is currently drawing ${drawKw} kW. ` +
          `Open the Rivian app → Charging → set the limit to ${snapshot.ev_soc}%, ` +
          `or unplug.`,
        rivianAppUrl: RIVIAN_APP_URL,
        signature: `stop:high:bucket${bucket}`,
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
  // Push copy under Option B: the car will draw whatever its OBC and
  // the cable allow regardless of any rate suggestion in the push, so
  // we deliberately do NOT include a rate number ("charge at 1.5 kW"
  // is misleading — the car heard 11 kW). Instead we surface what
  // the user CAN set: the Rivian charge-limit %, and the projected
  // PW path so the user can sanity-check the plan.
  const rateKw = decision.desired_rate_kw;
  const limitPct = decision.ev_charge_limit_pct;
  const endPct = decision.projected_end_pw_pct;
  const depPct = decision.projected_departure_pw_pct;

  // Trajectory tail: "PW drops to X% by departure, refills to Y% by
  // sunset" (driving-day plans) or "PW ends at Y% by sunset" (parked).
  let trajectoryTail = "";
  if (typeof depPct === "number" && typeof endPct === "number") {
    trajectoryTail = ` Powerwall drops to ${depPct}% by departure, refills to ${endPct}% by sunset.`;
  } else if (typeof endPct === "number") {
    trajectoryTail = ` Powerwall projected at ${endPct}% by sunset.`;
  }

  // Action instruction: when projection set a limit %, prompt the
  // user to set it explicitly (the car self-stops there). Otherwise
  // the legacy "Start, or plug-and-play" instruction.
  const actionInstruction =
    typeof limitPct === "number"
      ? `Open the Rivian app → Charging → set limit to ${limitPct}%, then Start.`
      : `Open the Rivian app → Charging → Start, or plug-and-play if already connected.`;

  if (!charging) {
    return {
      kind: "start",
      priority: "high",
      title: "Start EV charging now",
      body: `${decision.reason}.${trajectoryTail} ${actionInstruction}`,
      rivianAppUrl: RIVIAN_APP_URL,
      // Signature is now keyed on the limit % (the user-actionable
      // thing that changes plan-to-plan). Falls back to rounded rate
      // for legacy paths that don't set a limit.
      signature:
        typeof limitPct === "number"
          ? `start:high:limit${limitPct}`
          : `start:high:rate${rateKw ? Math.round(rateKw * 2) / 2 : "?"}`,
    };
  }

  // Already charging — no high-priority action needed. Surface the
  // current draw alongside the projection summary so the user can
  // sanity-check plan vs reality.
  const currentRateKw = (snapshot.ev_w / 1000).toFixed(1);
  return {
    kind: "noop",
    priority: "info",
    title: "EV charging — engine in sync",
    body: `Car drawing ${currentRateKw} kW. ${decision.reason}.${trajectoryTail}`,
    rivianAppUrl: RIVIAN_APP_URL,
    signature: `noop:start-and-charging`,
  };
}
