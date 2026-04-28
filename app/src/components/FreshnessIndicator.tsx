"use client";

import { useEffect, useState } from "react";

type Props = {
  /** ISO timestamp of the last successful fetch. */
  timestamp: string | undefined;
  /** True while a fetch is in flight (SWR's isValidating). */
  isValidating: boolean;
};

/**
 * Small "Updated Xs ago" pill with a pulsing dot when a fetch is in
 * flight. Lives in the app header so the user can answer "is this
 * data current?" at a glance — the actual freshness work happens in
 * useStatus + useVisibilityRefresh; this is the visible feedback for
 * those mechanisms.
 *
 * The relative-time string ticks every 5s on a local interval (no
 * network). When SWR fires a revalidation the dot pulses; when the
 * fetch completes the timestamp prop updates and the counter resets
 * to "now."
 */
export function FreshnessIndicator({ timestamp, isValidating }: Props) {
  // Re-render every 5s so "Xs ago" stays current without thrashing.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(id);
  }, []);

  const label = timestamp ? formatRelative(new Date(timestamp)) : "—";

  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] font-medium"
      style={{ color: "var(--text-tertiary)" }}
      aria-live="polite"
      aria-label={
        timestamp
          ? `Data updated ${label}${isValidating ? ", refreshing" : ""}`
          : "Data not loaded"
      }
    >
      <Dot pulsing={isValidating} />
      <span>Updated {label}</span>
    </span>
  );
}

function Dot({ pulsing }: { pulsing: boolean }) {
  return (
    <span
      className="inline-block w-[6px] h-[6px] rounded-full"
      style={{
        background: pulsing ? "var(--vehicle)" : "var(--text-tertiary)",
        animation: pulsing ? "helios-pulse 1.2s ease-in-out infinite" : undefined,
      }}
    />
  );
}

/**
 * Human-friendly relative-time formatter for short windows. We don't
 * need the precision of Intl.RelativeTimeFormat past a few minutes —
 * after that the cron has fired and the timestamp will reset anyway.
 */
function formatRelative(then: Date): string {
  const seconds = Math.max(0, Math.round((Date.now() - then.getTime()) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}
