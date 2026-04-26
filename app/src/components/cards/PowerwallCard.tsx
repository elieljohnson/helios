import { Card } from "@/components/Card";
import type { StatusResponse } from "@/lib/types";

type Props = { data: StatusResponse };

export function PowerwallCard({ data }: Props) {
  const { snapshot, system } = data;
  const charging = snapshot.pw_w > 0;
  const flow = (Math.abs(snapshot.pw_w) / 1000).toFixed(1);

  return (
    <Card signal="var(--battery)" label="Powerwall">
      <div className="flex items-baseline gap-2.5 mb-4">
        <span className="h-hero text-battery" style={{ fontSize: 52 }}>
          {snapshot.pw_soc}
        </span>
        <span className="text-base text-text-secondary font-medium">%</span>
        <span className="ml-auto text-[15px] text-text-tertiary mono">
          {charging ? `Charging ${flow} kW` : snapshot.pw_w < 0 ? `Discharging ${flow} kW` : "Idle"}
        </span>
      </div>

      <div className="flex gap-1.5">
        {system.powerwalls.map((pw) => (
          <div key={pw.id} className="flex-1">
            <div className="h-2 rounded-full bg-surface-inset overflow-hidden">
              <div
                className="h-full"
                style={{ width: `${pw.soc}%`, background: "var(--battery)" }}
              />
            </div>
            <div className="mt-1.5 flex justify-between text-[15px] text-text-tertiary mono">
              <span>{pw.id}</span>
              <span>{pw.soc}%</span>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 pt-4 border-t border-hairline grid grid-cols-2 gap-3 text-[15px]">
        <Stat label="Reserve" value={`${snapshot.pw_reserve}%`} sub="automated" />
        <Stat label="Mode" value={snapshot.pw_mode} />
        <Stat label="Capacity" value={`${system.battery.total} kWh`} sub={`${system.battery.count} × ${system.battery.capacity}`} />
        <Stat label="Sunset refill" value="~86%" />
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
