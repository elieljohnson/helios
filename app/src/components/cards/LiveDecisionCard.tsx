"use client";

// Real-time view of what the decision engines would do *right now* given
// the current snapshot, forecast, and saved config. Refreshes every 30s
// and after every Settings save (parent calls mutate). This is the page
// that makes the otherwise-invisible engine output legible.

import useSWR from "swr";
import { Card } from "@/components/Card";
import type { ConfigResponse, EnergySnapshot, SystemConfig } from "@/lib/types";

type DecideOutput = {
  target_reserve_pct: number;
  should_act: boolean;
  reasoning: string[];
  surplus_kw: number;
};

type EvDecideOutput = {
  action: "start" | "stop" | "hold";
  reason: string;
  reasoning: string[];
  budget_kwh?: number;
  desired_rate_kw?: number;
};

export type PreviewDecisionResponse = {
  timestamp: string;
  snapshot: EnergySnapshot;
  system: SystemConfig;
  sunrise?: string;
  sunset?: string;
  tomorrow_kwh?: number;
  config: ConfigResponse;
  reserve_decision: DecideOutput;
  ev_decision: EvDecideOutput;
};

const fetcher = (url: string) =>
  fetch(url).then((r) => r.json() as Promise<PreviewDecisionResponse>);

export function LiveDecisionCard() {
  const { data, isLoading } = useSWR<PreviewDecisionResponse>(
    "/api/preview-decision",
    fetcher,
    { refreshInterval: 30 * 1000, revalidateOnFocus: true },
  );

  if (isLoading || !data) {
    return (
      <Card signal="var(--vehicle)" label="Live status">
        <div className="text-text-tertiary text-[13px] mono">running engines…</div>
      </Card>
    );
  }

  const { ev_decision, reserve_decision, snapshot, sunset, tomorrow_kwh } = data;
  const localTime = new Date(data.timestamp).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  });
  const sunsetTime = sunset
    ? new Date(sunset).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Los_Angeles",
      })
    : "—";

  return (
    <Card signal="var(--vehicle)" label="Live status" spark={localTime}>
      {/* EV charge decision */}
      <div className="mb-5">
        <div className="text-[10px] uppercase tracking-[0.1em] text-text-tertiary font-semibold mb-1.5">
          EV Charge
        </div>
        <ActionLine action={ev_decision.action} rateKw={ev_decision.desired_rate_kw} />
        <div className="text-[15px] text-text-secondary mt-1.5">{ev_decision.reason}</div>
        <ReasoningChain steps={ev_decision.reasoning} />
      </div>

      <div className="border-t border-hairline pt-4 mb-5">
        <div className="text-[10px] uppercase tracking-[0.1em] text-text-tertiary font-semibold mb-1.5">
          Powerwall Reserve
        </div>
        <div className="flex items-baseline gap-2">
          <span
            className="h-hero"
            style={{
              fontSize: 28,
              color: reserve_decision.should_act ? "var(--battery)" : "var(--text-primary)",
            }}
          >
            {reserve_decision.should_act ? "SET" : "HOLD"}
          </span>
          <span className="mono text-[16px] text-text-secondary">
            {reserve_decision.target_reserve_pct}%
          </span>
          <span className="text-[12px] text-text-tertiary ml-2">
            current {snapshot.pw_reserve}%
          </span>
        </div>
        <ReasoningChain steps={reserve_decision.reasoning} />
      </div>

      {/* Grid flow — a consequence of the EV + PW decisions above, not
       *  a decision in its own right. Surfaced here so the user can see
       *  whether the system's current routing is producing import,
       *  export, or balance. Card was previously silent on this; with
       *  PW full and EV unplugged the only meaningful action is "where
       *  does the surplus go" and that's the grid line below. */}
      <div className="border-t border-hairline pt-4 mb-5">
        <div className="text-[10px] uppercase tracking-[0.1em] text-text-tertiary font-semibold mb-1.5">
          Grid
        </div>
        <GridStatus snapshot={snapshot} config={data.config} />
      </div>

      {/* Inputs to the engines, for context */}
      <div className="border-t border-hairline pt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Sunset" value={sunsetTime} />
        <Stat label="PW SoC" value={`${snapshot.pw_soc}%`} />
        <Stat label="EV SoC" value={`${snapshot.ev_soc}%`} />
        <Stat label="Tomorrow" value={tomorrow_kwh != null ? `${tomorrow_kwh} kWh` : "—"} />
      </div>
    </Card>
  );
}

/** Renders the live grid flow as a status, not a decision. Three states:
 *
 *   - EXPORTING (grid_w < 0): green, shows ~$/h credit accruing
 *   - IMPORTING (grid_w > 0): alert color, shows current TOU rate cost
 *   - IDLE (|grid_w| ≤ 50 W): neutral, supply ≈ demand
 *
 * The reasoning bullets explain *why* — what's currently producing,
 * what's currently consuming, and where the imbalance lands. Mirrors
 * the EV/Reserve sections' pattern so users have one shape to read.
 */
function GridStatus({
  snapshot,
  config,
}: {
  snapshot: EnergySnapshot;
  config: ConfigResponse;
}) {
  const gridKw = snapshot.grid_w / 1000;
  const exporting = gridKw < -0.05;
  const importing = gridKw > 0.05;
  const flowKw = Math.abs(gridKw);

  // House (true house, not load_power which includes EV) for the
  // reasoning chain. Same convention HeroCard uses.
  const houseKw = Math.max(0, (snapshot.home_w - snapshot.ev_w) / 1000);
  const solarKw = snapshot.solar_w / 1000;
  const evKw = snapshot.ev_w / 1000;
  const pwKw = -snapshot.pw_w / 1000; // sign-flip to "+ = into PW (charging)"

  let label: string;
  let color: string;
  let rateLine: string;
  const reasoning: string[] = [];

  if (exporting) {
    label = "EXPORTING";
    color = "var(--battery)";
    const dollarsPerHour = flowKw * config.nem_export_rate_per_kwh;
    rateLine = `${flowKw.toFixed(1)} kW · ~$${dollarsPerHour.toFixed(2)}/h NEM credit`;
    reasoning.push(
      `Solar ${solarKw.toFixed(1)} kW, house ${houseKw.toFixed(1)} kW, ` +
        `EV ${evKw.toFixed(1)} kW, PW ${pwKw >= 0.05 ? `+${pwKw.toFixed(1)}` : pwKw <= -0.05 ? pwKw.toFixed(1) : "0"} kW.`,
    );
    reasoning.push(
      `On-site sinks can't absorb ${flowKw.toFixed(1)} kW surplus → flows to grid at ` +
        `~$${config.nem_export_rate_per_kwh.toFixed(2)}/kWh NBT credit.`,
    );
  } else if (importing) {
    label = "IMPORTING";
    color = "var(--alert)";
    const dollarsPerHour = flowKw * snapshot.tou_rate;
    rateLine = `${flowKw.toFixed(1)} kW · ~$${dollarsPerHour.toFixed(2)}/h at ${snapshot.tou_period} rate`;
    reasoning.push(
      `Solar ${solarKw.toFixed(1)} kW, house ${houseKw.toFixed(1)} kW, ` +
        `EV ${evKw.toFixed(1)} kW, PW ${pwKw >= 0.05 ? `+${pwKw.toFixed(1)}` : pwKw <= -0.05 ? pwKw.toFixed(1) : "0"} kW.`,
    );
    reasoning.push(
      `On-site supply short by ${flowKw.toFixed(1)} kW → drawing from grid at ` +
        `$${snapshot.tou_rate.toFixed(2)}/kWh.`,
    );
  } else {
    label = "BALANCED";
    color = "var(--text-tertiary)";
    rateLine = `${flowKw.toFixed(1)} kW`;
    reasoning.push(
      `Solar ${solarKw.toFixed(1)} kW matches on-site demand. No grid flow.`,
    );
  }

  return (
    <>
      <div className="flex items-baseline gap-2">
        <span className="h-hero" style={{ fontSize: 28, color }}>
          {label}
        </span>
        <span className="mono text-[14px] text-text-secondary">{rateLine}</span>
      </div>
      <ReasoningChain steps={reasoning} />
    </>
  );
}

function ActionLine({
  action,
  rateKw,
}: {
  action: "start" | "stop" | "hold";
  rateKw?: number;
}) {
  const palette = {
    start: { color: "var(--vehicle)", label: "START" },
    stop: { color: "var(--alert)", label: "STOP" },
    hold: { color: "var(--text-tertiary)", label: "HOLD" },
  } as const;
  const p = palette[action];
  return (
    <div className="flex items-baseline gap-2">
      <span className="h-hero" style={{ fontSize: 28, color: p.color }}>
        {p.label}
      </span>
      {rateKw != null && (
        <span className="mono text-[16px] text-text-secondary">
          @ {rateKw} kW
        </span>
      )}
    </div>
  );
}

function ReasoningChain({ steps }: { steps: string[] }) {
  return (
    <ol className="mt-3 space-y-1.5">
      {steps.map((s, i) => (
        <li
          key={i}
          className="text-[12px] text-text-secondary leading-relaxed pl-3 relative"
        >
          <span
            className="absolute left-0 top-[8px] w-[3px] h-[3px] rounded-full"
            style={{ background: "var(--text-tertiary)" }}
            aria-hidden
          />
          {s}
        </li>
      ))}
    </ol>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.1em] text-text-tertiary">
        {label}
      </div>
      <div className="mono text-[15px] text-text-primary mt-0.5">{value}</div>
    </div>
  );
}
