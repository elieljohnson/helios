import { Card } from "@/components/Card";
import { getNextTransition } from "@/lib/rates";
import type { StatusResponse } from "@/lib/types";

type Props = { data: StatusResponse };

export function CostCard({ data }: Props) {
  const { snapshot, system } = data;
  // Derive next transition from the same schedule the engine uses for
  // tou_period/tou_rate, so the card never disagrees with itself.
  const next = getNextTransition(new Date());

  return (
    <Card signal="var(--alert)" label="Cost today">
      <div className="flex items-baseline gap-1 mb-3">
        <span className="text-[32px] text-text-secondary font-medium">$</span>
        <span className="h-hero text-text-primary" style={{ fontSize: 64 }}>
          {snapshot.daily_cost.toFixed(2)}
        </span>
      </div>

      <div className="flex items-center gap-2 text-[12px] mb-5">
        <span
          className="uppercase tracking-[0.1em] font-semibold px-2 py-0.5 rounded"
          style={{ background: "var(--surface-inset)", color: "var(--alert)" }}
        >
          {snapshot.tou_period}
        </span>
        <span className="text-text-secondary mono">
          ${snapshot.tou_rate.toFixed(2)}/kWh · until {next.display}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 text-[15px]">
        <Stat label="This week" value={`$${snapshot.week_cost.toFixed(2)}`} />
        <Stat label="This month" value={`$${snapshot.month_cost.toFixed(2)}`} />
        <Stat
          label="Utility"
          value={system.utility.replace("PG&E ", "")}
          sub="PG&E"
        />
        <Stat
          label="Next transition"
          value={next.display}
          sub={`to ${next.toPeriod} $${next.toRate.toFixed(2)}`}
        />
      </div>
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.1em] text-text-tertiary">{label}</div>
      <div className="mt-1 font-medium text-text-primary">{value}</div>
      {sub && <div className="text-[11px] text-text-tertiary mono">{sub}</div>}
    </div>
  );
}
