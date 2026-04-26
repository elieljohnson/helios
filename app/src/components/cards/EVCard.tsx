import { Card } from "@/components/Card";
import type { StatusResponse } from "@/lib/types";

type Props = { data: StatusResponse };

export function EVCard({ data }: Props) {
  const { snapshot, system } = data;
  const pct = snapshot.ev_soc;
  const circ = 2 * Math.PI * 36;
  const solarPct = snapshot.ev_source.solar ?? 0;
  const gridPct = snapshot.ev_source.grid ?? 0;

  return (
    <Card signal="var(--vehicle)" label={system.vehicle.model}>
      <div className="flex items-center gap-4">
        <div className="relative w-[100px] h-[100px] shrink-0">
          <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
            <circle cx="50" cy="50" r="36" fill="none" stroke="var(--surface-inset)" strokeWidth="6" />
            <circle
              cx="50"
              cy="50"
              r="36"
              fill="none"
              stroke="var(--vehicle)"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={`${(pct / 100) * circ} ${circ}`}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[28px] font-semibold tnum text-text-primary">{pct}</span>
            <span className="text-[9px] uppercase tracking-[0.14em] text-text-tertiary">percent</span>
          </div>
        </div>

        <div className="flex-1">
          <div className="text-[15px] text-text-secondary">{snapshot.ev_charging ? "Charging at" : "Idle"}</div>
          <div className="flex items-baseline gap-1.5">
            <span className="h-hero text-text-primary" style={{ fontSize: 36 }}>
              {(snapshot.ev_w / 1000).toFixed(1)}
            </span>
            <span className="text-text-secondary font-medium">kW</span>
          </div>
          <div className="mt-1 text-[12px] text-text-secondary mono">
            {snapshot.ev_range} mi range · target {snapshot.ev_target}%
          </div>
        </div>
      </div>

      <div className="mt-4">
        <div className="flex h-[10px] rounded-full overflow-hidden bg-surface-inset">
          <div style={{ width: `${solarPct}%`, background: "var(--solar)" }} />
          <div style={{ width: `${gridPct}%`, background: "var(--grid)" }} />
        </div>
        <div className="mt-2 flex gap-3 text-[11px] text-text-secondary">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: "var(--solar)" }} />
            {solarPct}% solar
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: "var(--grid)" }} />
            {gridPct}% grid
          </span>
        </div>
      </div>
    </Card>
  );
}
