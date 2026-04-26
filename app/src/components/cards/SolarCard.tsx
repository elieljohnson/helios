import { Card } from "@/components/Card";
import type { StatusResponse } from "@/lib/types";

type Props = { data: StatusResponse };

export function SolarCard({ data }: Props) {
  const curve = data.solar_curve;
  const now = new Date().getHours();
  const max = Math.max(...curve);
  const produced = +curve.slice(0, now + 1).reduce((a, b) => a + b, 0).toFixed(1);
  const forecast = +curve.reduce((a, b) => a + b, 0).toFixed(1);
  const peak = data.system.solar.peak;

  return (
    <Card signal="var(--solar)" label="Solar">
      <div className="flex items-baseline gap-2.5 mb-4">
        <span className="h-hero text-solar" style={{ fontSize: 52 }}>
          {(data.snapshot.solar_w / 1000).toFixed(1)}
        </span>
        <span className="text-base text-text-secondary font-medium">kW</span>
        <span className="ml-auto text-[15px] text-text-tertiary mono">of {peak} peak</span>
      </div>

      <div className="flex items-end gap-[2px] h-[52px] mb-2.5">
        {curve.map((v, h) => {
          const isNow = h === now;
          const isPast = h < now;
          const hFr = max ? v / max : 0;
          return (
            <div
              key={h}
              className="flex-1 rounded-t-[3px] relative"
              style={{
                height: `${Math.max(2, hFr * 100)}%`,
                background: v === 0 ? "var(--surface-inset)" : isPast || isNow ? "var(--solar)" : "var(--solar-soft)",
                opacity: v === 0 ? 0.4 : isPast ? 1 : isNow ? 1 : 0.55,
              }}
            />
          );
        })}
      </div>

      <div className="flex justify-between text-[15px] text-text-tertiary mono">
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
      </div>

      <div className="mt-4 pt-4 border-t border-hairline grid grid-cols-2 gap-3 text-[15px]">
        <Stat label="Today, so far" value={`${produced} kWh`} />
        <Stat label="Forecast total" value={`${forecast} kWh`} />
        <Stat label="Array" value={`${data.system.solar.count}× ${data.system.solar.model.replace("Enphase ", "")}`} sub={`${peak} kW peak`} />
      </div>
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="text-[15px] uppercase tracking-[0.1em] text-text-tertiary">{label}</div>
      <div className="mt-1 font-medium text-text-primary">{value}</div>
      {sub && <div className="text-[15px] text-text-tertiary mono">{sub}</div>}
    </div>
  );
}
