"use client";

// Self-sufficiency over time. Shows a big headline % for the selected
// period and a bar chart of bucketed values: Day → 24 hourly, Week →
// 7 daily, Month → 30 daily, Year → 12 monthly. Buckets with no
// captured data are omitted (no zero-bars cluttering the chart).
//
// Headline is weighted by actual energy consumed across the window —
// long high-consumption days don't get diluted by short low-consumption
// days. See lib/db.ts:getSelfSufficiencyHistory.

import { useState } from "react";
import useSWR from "swr";

type Period = "day" | "week" | "month" | "year";

type Point = { label: string; value: number; home_kwh: number };
type History = {
  period: Period;
  headline_pct: number;
  points: Point[];
  /** Gross $ spent on grid imports across the window. */
  import_usd: number;
  /** Gross NEM 3.0 export credits earned across the window. */
  export_credit_usd: number;
};

const PERIOD_LABELS: Record<Period, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  year: "Year",
};

const fetcher = (url: string) =>
  fetch(url).then((r) => r.json() as Promise<History>);

export function SelfSufficiencyHistoryCard() {
  // Default to Day on every page load. Day reflects "what's happening
  // right now" — the most likely user intent. The other views are one
  // tap away. Persisting across visits made repeat-visitors land on
  // Year or Month and miss today's pattern.
  const [period, setPeriod] = useState<Period>("day");
  const { data, isLoading } = useSWR<History>(
    `/api/history/self-sufficiency?period=${period}`,
    fetcher,
    { refreshInterval: 60 * 1000 },
  );

  const headline = data?.headline_pct ?? 0;
  const points = data?.points ?? [];

  return (
    <section className="h-card">
      <div className="h-card-head">
        <span className="label" style={{ color: "var(--text-secondary)" }}>
          Self-sufficiency · {PERIOD_LABELS[period].toLowerCase()}
        </span>
        <div className="ml-auto inline-flex gap-1 text-[11px] uppercase tracking-[0.06em]">
          {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className="px-2.5 py-1 rounded-[8px] font-semibold border transition-colors"
              style={{
                borderColor:
                  p === period ? "var(--text-primary)" : "var(--hairline)",
                background:
                  p === period ? "var(--text-primary)" : "transparent",
                color:
                  p === period ? "var(--surface-card)" : "var(--text-secondary)",
              }}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4 flex items-end justify-between gap-4">
        <div className="flex items-baseline gap-1">
          <span className="h-hero text-battery" style={{ fontSize: 64 }}>
            {isLoading ? "—" : headline}
          </span>
          <span className="text-[24px] text-text-secondary font-medium">%</span>
        </div>
        {/* $ spent + NEM credits earned across the same window. Both
            are gross (not netted) — the dashboard's CostCard handles
            the net daily number; this two-line block answers the
            week / month / year question that lives nowhere else. */}
        {!isLoading && data && (
          <dl className="text-right shrink-0 space-y-1">
            <div className="flex items-baseline gap-2 justify-end">
              <dt className="text-[10px] uppercase tracking-[0.08em] text-text-tertiary font-semibold">
                Spent
              </dt>
              <dd className="text-[15px] font-semibold text-text-primary mono tabular-nums">
                ${data.import_usd.toFixed(2)}
              </dd>
            </div>
            <div className="flex items-baseline gap-2 justify-end">
              <dt className="text-[10px] uppercase tracking-[0.08em] text-text-tertiary font-semibold">
                Credit
              </dt>
              <dd className="text-[15px] font-semibold text-battery mono tabular-nums">
                ${data.export_credit_usd.toFixed(2)}
              </dd>
            </div>
          </dl>
        )}
      </div>

      {isLoading ? (
        <div className="text-text-tertiary text-[13px] mono">loading…</div>
      ) : points.length === 0 ? (
        <div className="text-text-tertiary text-[12px] leading-relaxed py-4">
          No snapshots in this window yet. Data populates as the cron
          loop runs (every 5 min).
        </div>
      ) : (
        <BarChart points={points} period={period} />
      )}
    </section>
  );
}

function BarChart({ points, period }: { points: Point[]; period: Period }) {
  // Fixed 0–100% scale (values are percentages) so 80% always looks
  // like 80% across periods. Layout reserves a left gutter for the
  // Y-axis labels so 0/50/100 line up flush with the gridlines.
  const W = 640;
  const H = 120;
  const yAxisW = 28; // gutter for "100%" / "50%" / "0%" labels
  const padR = 4;
  const padY = 8;
  const usableW = W - yAxisW - padR;
  const usableH = H - padY * 2;
  const bw = usableW / Math.max(points.length, 1);
  // Show ≤8 labels on the X axis to avoid overlap on Month / Year.
  const labelStride = Math.max(1, Math.ceil(points.length / 8));

  // Y-axis tick positions (0 / 50 / 100 in chart space).
  const yTick = (pct: number) => padY + usableH * (1 - pct / 100);

  // Selected bar index for tap-to-reveal tooltip. Mobile-friendly:
  // tap a bar to show the value; tap the same bar again or any blank
  // chart space to dismiss. On desktop, hover also previews — but
  // selection sticks until cleared so a user can read the value
  // without holding the cursor.
  const [selected, setSelected] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const active = selected ?? hovered;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-[120px]"
        onClick={(e) => {
          // Click on the SVG background (not a bar) clears selection.
          if (e.target === e.currentTarget) setSelected(null);
        }}
      >
        {/* Y-axis gridlines + labels. The labels live in the gutter on
            the left; lines stretch across the chart area. */}
        {[0, 50, 100].map((pct) => (
          <g key={pct}>
            <line
              x1={yAxisW}
              x2={W - padR}
              y1={yTick(pct)}
              y2={yTick(pct)}
              stroke="var(--hairline)"
              strokeDasharray={pct === 50 ? "3 3" : undefined}
            />
            <text
              x={yAxisW - 4}
              y={yTick(pct) + 3}
              textAnchor="end"
              fontSize="10"
              fill="var(--text-tertiary)"
              fontFamily="var(--font-mono, ui-monospace, monospace)"
            >
              {pct}
            </text>
          </g>
        ))}

        {points.map((p, i) => {
          const h = (p.value / 100) * usableH;
          const x = yAxisW + i * bw + 1;
          const y = padY + (usableH - h);
          const w = Math.max(2, bw - 2);
          // Color ramp: ≥80% battery green; 50–80% solar amber; <50% alert.
          const color =
            p.value >= 80
              ? "var(--battery)"
              : p.value >= 50
                ? "var(--solar)"
                : "var(--alert)";
          const isActive = active === i;
          return (
            <g key={i}>
              {/* Real bar */}
              <rect
                x={x}
                y={y}
                width={w}
                height={Math.max(1, h)}
                rx={2}
                fill={color}
                opacity={active != null && !isActive ? 0.45 : 1}
              />
              {/* Invisible full-height hit target so tiny bars (low %)
                  are still tappable. Sits above the bar in z-order
                  because SVG paints in document order. */}
              <rect
                x={x}
                y={padY}
                width={w}
                height={usableH}
                fill="transparent"
                style={{ cursor: "pointer" }}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected((s) => (s === i ? null : i));
                }}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
              />
            </g>
          );
        })}
      </svg>

      {/* Tooltip — HTML, positioned by percentage of bar center.
          Anchored to the chart container; `pointer-events: none` so it
          never eats clicks on adjacent bars. We position it ABOVE the
          bar when there's room, BELOW when the bar is tall (≥70%) so
          the tip never clips the top of the chart. */}
      {active != null && points[active] && (
        <Tooltip
          point={points[active]}
          xPct={((yAxisW + active * bw + bw / 2) / W) * 100}
          flipBelow={points[active].value >= 70}
        />
      )}

      {/* X-axis labels — aligned to bar centers. We pad the leading
          spacer to match the SVG's yAxisW gutter so labels line up
          with their bars. */}
      <div
        className="mt-1 flex text-[10px] text-text-tertiary mono"
        style={{ paddingLeft: `${(yAxisW / W) * 100}%` }}
      >
        <div className="flex flex-1 justify-between">
          {points.map((p, i) =>
            i % labelStride === 0 || i === points.length - 1 ? (
              <span key={i}>{p.label}</span>
            ) : (
              <span key={i} aria-hidden />
            ),
          )}
        </div>
      </div>
      <div className="mt-3 text-[11px] text-text-tertiary leading-relaxed">
        {period === "day"
          ? "Hourly buckets, today PT. Resets at midnight. Tap a bar to see the value."
          : period === "week"
            ? "Daily buckets, last 7 days. Tap a bar to see the value."
            : period === "month"
              ? "Daily buckets, last 30 days. Tap a bar to see the value."
              : "Monthly buckets, last 12 months. Tap a bar to see the value."}
      </div>
    </div>
  );
}

function Tooltip({
  point,
  xPct,
  flipBelow,
}: {
  point: Point;
  xPct: number;
  flipBelow: boolean;
}) {
  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left: `${xPct}%`,
        // Above the chart at top:0 with translate(-50%, -100%); below
        // for tall bars to avoid clipping at the top of the SVG.
        top: flipBelow ? "calc(100% - 28px)" : 0,
        transform: flipBelow
          ? "translate(-50%, 8px)"
          : "translate(-50%, -100%)",
      }}
    >
      <div
        className="px-2.5 py-1.5 rounded-[8px] border whitespace-nowrap shadow-sm"
        style={{
          background: "var(--surface-card)",
          borderColor: "var(--hairline)",
        }}
      >
        <div className="text-[11px] text-text-tertiary mono leading-tight">
          {point.label}
        </div>
        <div className="text-[14px] font-semibold text-text-primary leading-tight mt-0.5">
          {point.value}%
        </div>
        <div className="text-[10.5px] text-text-tertiary mono leading-tight mt-0.5">
          {point.home_kwh.toFixed(1)} kWh
        </div>
      </div>
    </div>
  );
}
