import type { EnergySnapshot } from "@/lib/types";

type Props = { snapshot: EnergySnapshot };

/**
 * Hero card — self-sufficiency headline + a paired Supply/Demand bar.
 *
 * Energy flow model (matches Tesla's Fleet API convention):
 *   Supply (where energy is coming from right now):
 *     - solar_w (production from PV)
 *     - pw_w when > 0  (battery discharging — power OUT of the PW)
 *     - grid_w when > 0 (importing — power INTO the home from utility)
 *   Demand (where energy is going right now):
 *     - home_w  ← Tesla's load_power INCLUDES the EV draw, so we split
 *                 the bar segment into House (load_power − ev_w) and EV
 *                 instead of double-counting.
 *     - pw_w when < 0  (battery charging — power INTO the PW)
 *     - grid_w when < 0 (exporting — power OUT of the home to utility)
 *
 * Supply total ≈ Demand total (within measurement noise) by
 * conservation of energy. If they're persistently out of balance,
 * something upstream is reading stale or sign-flipped — surface it
 * here visually rather than silently miscounting.
 *
 * "Supply / Demand" beats "Producing / Consuming" because the PW
 * discharging isn't *producing* energy — it's releasing stored
 * energy. Same for grid imports. Supply/demand is the standard
 * utility-industry framing and reads correctly across all sources.
 */
export function HeroCard({ snapshot }: Props) {
  const solar_kw = snapshot.solar_w / 1000;
  const ev_kw = snapshot.ev_w / 1000;
  // Tesla's load_power is the home meter's total demand; subtracting
  // the EV's instantaneous draw gives the "house" loads (HVAC,
  // appliances, lights, everything else). Clamped to 0 because
  // brief negative values can show up at sign-flip moments when the
  // EV reading is fresher than the load reading.
  const house_kw = Math.max(0, (snapshot.home_w - snapshot.ev_w) / 1000);

  const pw_discharge_kw = Math.max(0, snapshot.pw_w / 1000);
  const pw_charge_kw = Math.max(0, -snapshot.pw_w / 1000);
  const grid_import_kw = Math.max(0, snapshot.grid_w / 1000);
  const grid_export_kw = Math.max(0, -snapshot.grid_w / 1000);

  const supply_kw = solar_kw + pw_discharge_kw + grid_import_kw;
  const demand_kw = house_kw + ev_kw + pw_charge_kw + grid_export_kw;
  // Conservation of energy — the four flows from one Tesla gateway
  // sample SHOULD reconcile to within measurement noise. When they
  // don't, it's almost always upstream (a single CT reading lagged
  // or sign-flipped during a sign-transition; gateway recovers by
  // the next snapshot). Surface the imbalance so the math the user
  // is reading is honest. 0.5 kW threshold sits above sensor noise
  // (~50W) and below any imbalance worth noticing visually.
  const imbalance_kw = supply_kw - demand_kw;
  const showImbalance = Math.abs(imbalance_kw) >= 0.5;

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
          label="Supply"
          totalKw={supply_kw}
          segments={[
            { label: "Solar", color: "var(--solar)", kw: solar_kw },
            { label: "Powerwall", color: "var(--battery)", kw: pw_discharge_kw },
            { label: "Grid", color: "var(--grid)", kw: grid_import_kw },
          ]}
        />
        <div className="mt-6" />
        <BarRow
          label="Demand"
          totalKw={demand_kw}
          segments={[
            { label: "House", color: "var(--home)", kw: house_kw },
            { label: "Rivian", color: "var(--vehicle)", kw: ev_kw },
            { label: "Powerwall", color: "var(--battery)", kw: pw_charge_kw },
            { label: "Grid export", color: "var(--grid)", kw: grid_export_kw },
          ]}
        />
        {showImbalance && <ImbalanceNote imbalance_kw={imbalance_kw} />}
      </div>
    </div>
  );
}

/**
 * Inline note shown when the supply/demand bars don't reconcile
 * (|supply − demand| ≥ 0.5 kW). Conservation of energy says the four
 * Tesla flows from a single sample SHOULD balance; when they don't,
 * one CT reading is briefly out of sync. Telling the user this
 * directly beats letting them math it out themselves and conclude
 * the dashboard is broken.
 *
 * The note also hints which side is most likely stale, so a future
 * postmortem-of-the-day investigation can corroborate against the
 * upstream Tesla gateway data more efficiently.
 */
function ImbalanceNote({ imbalance_kw }: { imbalance_kw: number }) {
  const magnitude = Math.abs(imbalance_kw).toFixed(1);
  const supplyShort = imbalance_kw < 0; // demand > supply → missing source
  const hint = supplyShort
    ? "missing source — likely a stale grid import reading"
    : "missing sink — likely a stale load or charge reading";
  return (
    <div
      className="mt-4 px-3 py-2 rounded-lg text-[12px] leading-relaxed"
      style={{
        background: "color-mix(in srgb, var(--alert) 10%, transparent)",
        border: "0.5px solid color-mix(in srgb, var(--alert) 28%, transparent)",
        color: "var(--alert)",
      }}
      role="status"
    >
      <span className="font-medium uppercase tracking-[0.1em] text-[10px] mr-2">
        Imbalance
      </span>
      <span className="text-text-secondary">
        Supply and demand off by {magnitude} kW — Tesla gateway {hint}.
        Self-corrects on next snapshot.
      </span>
    </div>
  );
}

type Seg = { label: string; color: string; kw: number };

function BarRow({ label, totalKw, segments }: { label: string; totalKw: number; segments: Seg[] }) {
  // Hide near-zero segments from the bar AND the legend — keeps the
  // card tidy when only one or two sources/sinks are active.
  const display = segments.filter((s) => s.kw > 0.05);
  return (
    <div>
      <div className="flex items-baseline justify-between text-[11px] uppercase tracking-[0.1em] font-semibold text-text-secondary">
        <span>{label}</span>
        <span className="mono text-text-primary">{totalKw.toFixed(1)} kW</span>
      </div>
      <div className="mt-2 flex gap-[2px] h-6 bg-surface-inset rounded-md overflow-hidden">
        {display.map((s) => {
          const pct = totalKw > 0 ? (s.kw / totalKw) * 100 : 0;
          return (
            <div
              key={s.label}
              className="flex items-center px-2 text-[11px] mono text-white/95"
              style={{ width: `${pct}%`, background: s.color }}
            >
              {s.kw.toFixed(1)}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-3 text-[11px] text-text-secondary flex-wrap">
        {display.map((s) => (
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
