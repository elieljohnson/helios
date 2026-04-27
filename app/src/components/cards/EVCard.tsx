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
          {/* leading-none collapses the 28px digit's default line-height
              so the stacked number+label centers compactly inside the
              ring (radius 36 + stroke 6 → inner diameter ~66px). The
              gap separates the two and keeps percent off the ring. */}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
            <span className="text-[28px] font-semibold tnum text-text-primary leading-none">
              {pct}
            </span>
            <span className="text-[9px] uppercase tracking-[0.14em] text-text-tertiary leading-none">
              percent
            </span>
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

      {/* Stat strip below the source bar — mirrors SolarCard.tsx's
          "Today, so far / Forecast / Array" footer for visual rhythm. */}
      <div className="mt-4 pt-4 border-t border-hairline grid grid-cols-2 gap-3 text-[15px]">
        <Stat
          label="Today, so far"
          value={`${snapshot.ev_charged_today_kwh.toFixed(1)} kWh`}
        />
        <Stat
          label="Battery"
          value={`${system.vehicle.capacity} kWh`}
          sub={`${system.vehicle.max_charge} kW max`}
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
