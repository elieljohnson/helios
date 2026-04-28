import { Card } from "@/components/Card";
import { getNextTransition } from "@/lib/rates";
import type { StatusResponse } from "@/lib/types";

type Props = { data: StatusResponse };

/**
 * Cost card — shows today's net grid cost (imports priced at TOU,
 * minus exports priced at the flat NEM 3.0 export rate). When net
 * is NEGATIVE the user is accruing more credit than they're spending
 * today, and the number renders in green with a "−" sign.
 *
 * Important nuance the subtitle communicates: NEM 3.0 credits are
 * NOT cash. PG&E applies them at annual true-up against your imports
 * over the year — you can't end up with a check, only with offsets
 * up to your annual import total. So "earning $3.50 today" really
 * means "offsetting future bills up to $3.50 — maybe."
 */
export function CostCard({ data }: Props) {
  const { snapshot, system } = data;
  // Derive next transition from the same schedule the engine uses for
  // tou_period/tou_rate, so the card never disagrees with itself.
  const next = getNextTransition(new Date());

  const net = snapshot.daily_cost;
  const earning = net < 0;
  const absNet = Math.abs(net);
  // Sign character: +ve cost prefix is "$", credit prefix is "−$".
  // The dollar sign stays adjacent to the number so the magnitude
  // reads cleanly even with the minus.
  const heroColor = earning ? "var(--battery)" : "var(--text-primary)";

  return (
    <Card signal="var(--alert)" label="Cost today">
      <div className="flex items-baseline gap-1 mb-1">
        {/* Prefix wrapper: inline-flex with items-center so the "−"
         *  glyph (sits at math-axis, mid-x-height) visually centers
         *  with the "$" glyph (extends baseline → cap-height) instead
         *  of merely sharing a baseline. leading-none tightens the
         *  line box so the centering is precise. The wrapper itself
         *  baseline-aligns with the digits via the parent flex. */}
        <span
          className="inline-flex items-center text-[32px] font-medium leading-none"
          style={{ color: earning ? heroColor : "var(--text-secondary)" }}
        >
          {earning && <span>−</span>}
          <span>$</span>
        </span>
        <span className="h-hero" style={{ fontSize: 64, color: heroColor }}>
          {absNet.toFixed(2)}
        </span>
      </div>

      {earning && (
        <div className="text-[12px] text-text-tertiary mb-3">
          NEM credit · offsets future bills (not cash)
        </div>
      )}

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
        <Stat
          label="This week"
          value={formatNet(snapshot.week_cost)}
          green={snapshot.week_cost < 0}
        />
        <Stat
          label="This month"
          value={formatNet(snapshot.month_cost)}
          green={snapshot.month_cost < 0}
        />
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

/** Format a possibly-negative dollar value as "$X.XX" or "−$X.XX". */
function formatNet(value: number): string {
  const abs = Math.abs(value).toFixed(2);
  return value < 0 ? `−$${abs}` : `$${abs}`;
}

function Stat({
  label,
  value,
  sub,
  green,
}: {
  label: string;
  value: string;
  sub?: string;
  green?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.1em] text-text-tertiary">
        {label}
      </div>
      <div
        className="mt-1 font-medium"
        style={{
          color: green ? "var(--battery)" : "var(--text-primary)",
        }}
      >
        {value}
      </div>
      {sub && <div className="text-[11px] text-text-tertiary mono">{sub}</div>}
    </div>
  );
}
