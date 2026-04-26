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
      <Card signal="var(--vehicle)" label="Live decision">
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
    <Card signal="var(--vehicle)" label="Live decision" spark={localTime}>
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
