"use client";

// Self-sufficiency over time. Shows a big headline % for the selected
// period and a bar chart of bucketed values: Day → 24 hourly, Week →
// 7 daily, Month → 30 daily, Year → 12 monthly. Buckets with no
// captured data are omitted (no zero-bars cluttering the chart).
//
// Headline is weighted by actual energy consumed across the window —
// long high-consumption days don't get diluted by short low-consumption
// days. See lib/db.ts:getSelfSufficiencyHistory.

import { useEffect, useState } from "react";
import useSWR from "swr";

type Period = "day" | "week" | "month" | "year";

type Point = { label: string; value: number; home_kwh: number };
type History = {
  period: Period;
  headline_pct: number;
  points: Point[];
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
  const [period, setPeriod] = usePeriodState();
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

      <div className="flex items-baseline gap-1 mb-4">
        <span className="h-hero text-battery" style={{ fontSize: 64 }}>
          {isLoading ? "—" : headline}
        </span>
        <span className="text-[24px] text-text-secondary font-medium">%</span>
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

/** Persist the selected period across reloads in localStorage. SSR-safe:
 *  starts with "day" on the server, then hydrates from storage on
 *  client mount via useEffect. */
function usePeriodState(): [Period, (p: Period) => void] {
  const [period, setPeriodState] = useState<Period>("day");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("helios:ss_period");
      if (stored && (["day", "week", "month", "year"] as const).includes(stored as Period)) {
        setPeriodState(stored as Period);
      }
    } catch {
      // localStorage might be unavailable (private mode, etc.) — ignore.
    }
  }, []);
  const setPeriod = (p: Period) => {
    setPeriodState(p);
    try {
      window.localStorage.setItem("helios:ss_period", p);
    } catch {
      // ignore
    }
  };
  return [period, setPeriod];
}

function BarChart({ points, period }: { points: Point[]; period: Period }) {
  // Keep the chart visually consistent across periods: scale 0–100 fixed
  // (since values are percentages) so 80% always looks like 80%.
  const W = 600; // viewBox width
  const H = 96;
  const padX = 8;
  const padY = 8;
  const usableW = W - padX * 2;
  const usableH = H - padY * 2;
  const bw = usableW / Math.max(points.length, 1);
  // Show ≤8 labels on the X axis to avoid overlap on Month / Year.
  const labelStride = Math.max(1, Math.ceil(points.length / 8));

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="w-full h-[96px]"
      >
        {/* 50% guideline — orienting reference for "half self-sufficient". */}
        <line
          x1={padX}
          x2={W - padX}
          y1={padY + usableH / 2}
          y2={padY + usableH / 2}
          stroke="var(--hairline)"
          strokeDasharray="3 3"
        />
        {points.map((p, i) => {
          const h = (p.value / 100) * usableH;
          const x = padX + i * bw + 1;
          const y = padY + (usableH - h);
          // Color ramp: ≥80% battery green; 50–80% solar amber; <50% alert.
          const color =
            p.value >= 80
              ? "var(--battery)"
              : p.value >= 50
                ? "var(--solar)"
                : "var(--alert)";
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={Math.max(2, bw - 2)}
              height={Math.max(1, h)}
              rx={2}
              fill={color}
            />
          );
        })}
      </svg>
      <div className="mt-2 flex justify-between text-[10px] text-text-tertiary mono">
        {points.map((p, i) =>
          i % labelStride === 0 || i === points.length - 1 ? (
            <span key={i}>{p.label}</span>
          ) : (
            <span key={i} aria-hidden />
          ),
        )}
      </div>
      <div className="mt-3 text-[11px] text-text-tertiary leading-relaxed">
        {period === "day"
          ? "Hourly buckets, today PT. Resets at midnight."
          : period === "week"
            ? "Daily buckets, last 7 days."
            : period === "month"
              ? "Daily buckets, last 30 days."
              : "Monthly buckets, last 12 months."}
      </div>
    </div>
  );
}
