import { Card } from "@/components/Card";
import type { StatusResponse } from "@/lib/types";

type Props = { data: StatusResponse };

export function CostCard({ data }: Props) {
  const { snapshot, system } = data;
  const nextTransition = snapshot.tou_period === "off-peak" ? "15:00" : "21:00";
  const nextPeriod = snapshot.tou_period === "off-peak" ? "peak $0.58" : "off-peak $0.32";
  const naiveCost = snapshot.daily_cost + snapshot.daily_savings;

  return (
    <Card signal="var(--alert)" label="Cost today">
      <div className="flex items-baseline gap-1 mb-3">
        <span className="text-[32px] text-text-secondary font-medium">$</span>
        <span className="h-hero text-text-primary" style={{ fontSize: 64 }}>
          {snapshot.daily_cost.toFixed(2)}
        </span>
      </div>

      <div className="flex items-center gap-2 text-[12px] mb-4">
        <span
          className="uppercase tracking-[0.1em] font-semibold px-2 py-0.5 rounded"
          style={{ background: "var(--surface-inset)", color: "var(--alert)" }}
        >
          {snapshot.tou_period}
        </span>
        <span className="text-text-secondary mono">${snapshot.tou_rate.toFixed(2)}/kWh · until {nextTransition}</span>
      </div>

      <div
        className="flex items-center justify-between rounded-xl p-3 mb-4"
        style={{ background: "var(--surface-elevated)" }}
      >
        <div>
          <div className="text-[15px] text-text-primary">Saved vs naive charging</div>
          <div className="text-[11px] text-text-tertiary mono">Naive would have been</div>
        </div>
        <div className="text-right">
          <div className="text-battery mono font-semibold">-${snapshot.daily_savings.toFixed(2)}</div>
          <div className="text-[11px] text-text-tertiary mono">${naiveCost.toFixed(2)}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-[15px]">
        <Stat label="This week" value="$14.20" />
        <Stat label="Month saved" value="$182.40" />
        <Stat label="Utility" value={system.utility.replace("PG&E ", "")} sub="PG&E" />
        <Stat label="Next transition" value={nextTransition} sub={`to ${nextPeriod}`} />
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
