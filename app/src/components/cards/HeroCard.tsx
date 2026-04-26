import type { EnergySnapshot } from "@/lib/types";

type Props = { snapshot: EnergySnapshot };

export function HeroCard({ snapshot }: Props) {
  const producing_kw = snapshot.solar_w / 1000;
  const consuming_kw = (snapshot.home_w + snapshot.ev_w + Math.max(0, snapshot.pw_w)) / 1000;
  const home_pct = (snapshot.home_w / (consuming_kw * 1000)) * 100 || 0;
  const ev_pct = (snapshot.ev_w / (consuming_kw * 1000)) * 100 || 0;
  const storage_pct = Math.max(0, (snapshot.pw_w / (consuming_kw * 1000)) * 100) || 0;

  return (
    <div className="h-card">
      <div className="h-card-head">
        <span className="label">Optimized · Self-sufficient today</span>
      </div>

      <div className="flex items-baseline gap-1">
        <span className="h-hero text-battery" style={{ fontSize: 96 }}>
          {snapshot.self_sufficiency}
        </span>
        <span className="text-[32px] text-text-secondary font-medium">%</span>
      </div>

      <div className="mt-8">
        <BarRow
          label="Producing"
          totalKw={producing_kw}
          segments={[{ label: "Solar", color: "var(--solar)", kw: producing_kw }]}
        />
        <div className="mt-6" />
        <BarRow
          label="Consuming"
          totalKw={consuming_kw}
          segments={[
            { label: "Home", color: "var(--home)", kw: snapshot.home_w / 1000, pct: home_pct },
            { label: "Rivian", color: "var(--vehicle)", kw: snapshot.ev_w / 1000, pct: ev_pct },
            {
              label: "Storage",
              color: "var(--battery)",
              kw: Math.max(0, snapshot.pw_w / 1000),
              pct: storage_pct,
            },
          ]}
        />
      </div>
    </div>
  );
}

type Seg = { label: string; color: string; kw: number; pct?: number };

function BarRow({ label, totalKw, segments }: { label: string; totalKw: number; segments: Seg[] }) {
  const display = segments.filter((s) => s.kw > 0.05);
  return (
    <div>
      <div className="flex items-baseline justify-between text-[15px] uppercase tracking-[0.1em] font-semibold text-text-secondary">
        <span>{label}</span>
        <span className="mono text-text-primary">{totalKw.toFixed(1)} kW</span>
      </div>
      <div className="mt-2 flex gap-[2px] h-6 bg-surface-inset rounded-md overflow-hidden">
        {display.map((s, i) => {
          const pct = s.pct ?? (s.kw / totalKw) * 100;
          return (
            <div
              key={i}
              className="flex items-center px-2 text-[15px] mono text-white/95"
              style={{ width: `${pct}%`, background: s.color }}
            >
              {s.kw.toFixed(1)}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-3 text-[15px] text-text-secondary">
        {segments.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span
              className="w-[8px] h-[8px] rounded-[2px]"
              style={{ background: s.color }}
            />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
