"use client";

// Self-sufficiency over time. Shows a big headline % for the selected
// period and a bar chart of bucketed values: Day → 24 hourly, Week →
// 7 daily, Month → 30 daily, Year → 12 monthly. Buckets with no
// captured data are omitted (no zero-bars cluttering the chart).
//
// Headline is weighted by actual energy consumed across the window —
// long high-consumption days don't get diluted by short low-consumption
// days. See lib/db.ts:getSelfSufficiencyHistory.

import { useEffect, useRef, useState } from "react";
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
        <span className="label">
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

  // Selection model: tap-to-pin + drag-to-scrub. A single tap on a
  // bar pins the tooltip (sticky until tap-outside or tap-same-bar).
  // Touch-and-drag scrubs the selection across bars in real time — a
  // native-feeling pattern lifted from rauno.me/craft/graph-slider,
  // adapted for a discrete bar chart. Desktop hover still previews
  // independently of pinning.
  const [selected, setSelected] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const active = selected ?? hovered;

  // Global dismiss: any pointer-down outside the SVG itself closes
  // the tooltip. Scoped to the SVG (not the outer wrapper) so taps in
  // the 72px reserved space above the chart — where the tooltip
  // floats but the SVG hasn't started yet — correctly count as
  // "outside" and dismiss. Previous wrapper-scoped version treated
  // that whitespace as inside-chart and ignored the tap.
  //
  // The tooltip itself has pointer-events:none so a tap on it passes
  // through to whatever's beneath, which is the wrapper's padding,
  // which is outside the SVG — also correctly dismisses.
  const svgRef = useRef<SVGSVGElement | null>(null);
  useEffect(() => {
    if (selected == null) return;
    const handler = (e: PointerEvent) => {
      if (svgRef.current && !svgRef.current.contains(e.target as Node)) {
        setSelected(null);
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [selected]);

  // Refs used by the pointer handlers to detect tap-vs-drag and avoid
  // redundant state updates while scrubbing across the same bar.
  const overlayRef = useRef<SVGRectElement | null>(null);
  const prevSelectedRef = useRef<number | null>(null);
  const lastIndexRef = useRef<number | null>(null);
  const tapStartRef = useRef<{ x: number; y: number } | null>(null);

  /** Convert a pointer's viewport X to a bar index (0..points.length-1).
   *  Uses the overlay rect's bounding box rather than SVG viewBox units
   *  so the math survives any responsive width / scaling Tailwind applies. */
  function indexFromClientX(clientX: number): number | null {
    const el = overlayRef.current;
    if (!el || points.length === 0) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return null;
    const fraction = (clientX - rect.left) / rect.width;
    const i = Math.floor(fraction * points.length);
    return Math.max(0, Math.min(points.length - 1, i));
  }

  function onPointerDown(e: React.PointerEvent<SVGRectElement>) {
    // Ignore non-primary pointers (multi-touch second finger etc.) so
    // a second finger landing mid-scrub doesn't fight the first.
    if (!e.isPrimary) return;
    const idx = indexFromClientX(e.clientX);
    if (idx == null) return;
    // Capture so move events keep firing even if the finger drifts a
    // few pixels outside the chart bounds. This is what makes the
    // scrub feel "sticky" rather than fragile at the edges.
    e.currentTarget.setPointerCapture(e.pointerId);
    prevSelectedRef.current = selected;
    tapStartRef.current = { x: e.clientX, y: e.clientY };
    lastIndexRef.current = idx;
    setIsDragging(false);
    setSelected(idx);
  }

  function onPointerMove(e: React.PointerEvent<SVGRectElement>) {
    const captured = e.currentTarget.hasPointerCapture(e.pointerId);
    if (!captured) {
      // Mouse hover (no drag). Touch devices won't fire this branch.
      if (e.pointerType === "mouse") {
        setHovered(indexFromClientX(e.clientX));
      }
      return;
    }
    // Drag in progress. Promote to dragging once the pointer moves
    // beyond a small dead zone — distinguishes a tap (which should
    // toggle on pointerup) from a scrub.
    const start = tapStartRef.current;
    if (start && !isDragging) {
      const dx = Math.abs(e.clientX - start.x);
      const dy = Math.abs(e.clientY - start.y);
      if (dx > 4 || dy > 4) setIsDragging(true);
    }
    const idx = indexFromClientX(e.clientX);
    if (idx != null && idx !== lastIndexRef.current) {
      lastIndexRef.current = idx;
      setSelected(idx);
      // Haptic stub. No-op on iOS Safari (Apple doesn't expose the
      // Taptic Engine to PWAs) but produces a brief tap on Android
      // Chrome — one bar = one buzz, matching native scrubbers.
      navigator.vibrate?.(8);
    }
  }

  function onPointerUp(e: React.PointerEvent<SVGRectElement>) {
    const wasDrag = isDragging;
    const wasAlreadySelected = prevSelectedRef.current;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // Preserve the legacy tap-to-toggle: a clean tap on the
    // already-selected bar deselects. A drag-to-the-same-bar does
    // NOT deselect (that would punish a user who scrubbed away and
    // back, expecting the tooltip to stay).
    if (!wasDrag) {
      const idx = indexFromClientX(e.clientX);
      if (idx != null && idx === wasAlreadySelected) {
        setSelected(null);
      }
    }
    setIsDragging(false);
    tapStartRef.current = null;
  }

  function onPointerLeave(e: React.PointerEvent<SVGRectElement>) {
    if (e.pointerType === "mouse") setHovered(null);
  }

  function onPointerCancel(e: React.PointerEvent<SVGRectElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setIsDragging(false);
    tapStartRef.current = null;
  }

  // Reserve vertical space above the SVG so the tooltip — always
  // anchored to the top of the chart — can render fully visible
  // without overlapping the headline or being hidden by the user's
  // finger from below. ~72px fits the 3-line tooltip plus a small
  // breathing gap.
  const TOOLTIP_RESERVE_PX = 72;

  return (
    <div className="relative" style={{ paddingTop: TOOLTIP_RESERVE_PX }}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-[120px]"
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
          // Bars are visual-only now — pointer events route through
          // the single overlay rect below so per-bar hit targets are
          // no longer needed.
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={w}
              height={Math.max(1, h)}
              rx={2}
              fill={color}
              opacity={active != null && !isActive ? 0.45 : 1}
              style={{ pointerEvents: "none" }}
            />
          );
        })}

        {/* Scrub guideline — a thin vertical reference at the active
            bar's center. Only appears during an active drag so it
            reads as a "scrub cursor" affordance, not permanent chrome.
            Faded + dashed to keep visual weight low. */}
        {isDragging && active != null && (
          <line
            x1={yAxisW + active * bw + bw / 2}
            x2={yAxisW + active * bw + bw / 2}
            y1={padY}
            y2={padY + usableH}
            stroke="var(--text-secondary)"
            strokeWidth="1"
            strokeDasharray="2 3"
            opacity={0.45}
            style={{ pointerEvents: "none" }}
          />
        )}

        {/* Unified pointer overlay across the plot area. One handler
            for all bars: pointerdown picks the bar under finger,
            pointermove scrubs, pointerup pins (or toggles off on a
            clean re-tap of the same bar).

            touchAction: "none" on the overlay specifically — page
            scroll works everywhere else, but a touch that lands on
            the chart is a scrub, not a scroll. The overlay's
            footprint is small (~120px tall) so this isn't a scroll-
            hostage situation. */}
        <rect
          ref={overlayRef}
          x={yAxisW}
          y={padY}
          width={usableW}
          height={usableH}
          fill="transparent"
          style={{ cursor: "pointer", touchAction: "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
          onPointerCancel={onPointerCancel}
        />
      </svg>

      {/* Tooltip — HTML, positioned by percentage of bar center.
          Always renders above the chart (in the reserved
          TOOLTIP_RESERVE_PX zone), so a user's finger tapping from
          below never obscures the value. */}
      {active != null && points[active] && (
        <Tooltip
          point={points[active]}
          xPct={((yAxisW + active * bw + bw / 2) / W) * 100}
          reservePx={TOOLTIP_RESERVE_PX}
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
          ? "Hourly buckets, today PT. Resets at midnight. Tap or drag across to read values."
          : period === "week"
            ? "Daily buckets, last 7 days. Tap or drag across to read values."
            : period === "month"
              ? "Daily buckets, last 30 days. Tap or drag across to read values."
              : "Monthly buckets, last 12 months. Tap or drag across to read values."}
      </div>
    </div>
  );
}

function Tooltip({
  point,
  xPct,
  reservePx,
}: {
  point: Point;
  xPct: number;
  reservePx: number;
}) {
  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left: `${xPct}%`,
        // Anchor at the SVG's top edge; the reserved zone sits in
        // [0, reservePx] above the SVG (which begins at top=reservePx
        // because of the wrapper's paddingTop). Translate up by 100%
        // of own height plus 8px so the tooltip floats just above the
        // SVG's top, fully inside the reserved zone.
        top: reservePx,
        transform: "translate(-50%, calc(-100% - 8px))",
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
