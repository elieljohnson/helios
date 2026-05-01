"use client";

import { useState } from "react";
import useSWR from "swr";
import { AppShell } from "@/components/AppShell";
import { SelfSufficiencyHistoryCard } from "@/components/cards/SelfSufficiencyHistoryCard";
import { useStatus, useVisibilityRefresh } from "@/lib/useStatus";
import type { ActionEntry, ActionsResponse } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json() as Promise<ActionsResponse>);

const TYPE_COLOR: Record<ActionEntry["type"], string> = {
  reserve: "var(--battery)",
  charge: "var(--vehicle)",
  forecast: "var(--grid)",
  info: "var(--text-secondary)",
  alert: "var(--alert)",
};

const TYPE_LABEL: Record<ActionEntry["type"], string> = {
  reserve: "Reserve",
  charge: "Charge",
  forecast: "Forecast",
  info: "Info",
  alert: "Alert",
};

const PAGE_SIZE = 15;

export default function ActivityPage() {
  const status = useStatus();
  useVisibilityRefresh();
  const { data, isValidating: isValidatingActions } = useSWR<ActionsResponse>(
    "/api/actions",
    fetcher,
    { refreshInterval: 60 * 1000 },
  );

  // Pagination is purely client-side: /api/actions returns a healthy
  // batch (~50 by default) and the user usually only wants the recent
  // few. We render PAGE_SIZE on first paint and grow on demand —
  // simpler than wiring up cursor pagination and matches the user's
  // mental model of "show me more."
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const location = status.data?.system.location;
  const utility = status.data?.system.utility;

  const total = data?.actions.length ?? 0;
  const visible = data?.actions.slice(0, visibleCount) ?? [];
  const hasMore = visibleCount < total;

  // Activity page's "freshness" reflects the actions feed (not status).
  // Use the actions feed's own validating signal so the dot pulses when
  // /api/actions is being refetched, not /api/status.
  return (
    <AppShell
      location={location}
      utility={utility}
      freshness={{
        timestamp: status.data?.timestamp,
        isValidating: status.isValidating || isValidatingActions,
      }}
      health={
        status.data
          ? {
              sources: status.data.sources,
              assembly_errors: status.data.assembly_errors,
            }
          : undefined
      }
    >
      <div className="mb-4 px-2">
        <h1 className="text-[22px] font-semibold text-text-primary">Activity</h1>
        <p className="text-[15px] text-text-secondary mt-1">
          What the decision engine did today, and why.
        </p>
      </div>

      <SelfSufficiencyHistoryCard />

      <div className="h-card mt-3">
        {!data && <span className="text-text-tertiary text-[13px] mono">loading…</span>}
        {data && (
          <>
            <ul className="divide-y" style={{ borderColor: "var(--hairline)" }}>
              {visible.map((a, i) => (
                <li
                  key={`${a.timestamp}-${i}`}
                  className="flex items-start gap-4 py-3 first:pt-0 last:pb-0"
                  style={{ borderColor: "var(--hairline)" }}
                >
                  <span className="mono text-[12px] text-text-tertiary w-12 shrink-0 mt-0.5">
                    {a.display_time}
                  </span>
                  <span
                    className="mt-1 shrink-0 w-[8px] h-[8px] rounded-[2px]"
                    style={{ background: TYPE_COLOR[a.type] }}
                    aria-label={TYPE_LABEL[a.type]}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] font-medium text-text-primary">
                      {a.title}
                    </div>
                    <div className="text-[12.5px] text-text-secondary mt-0.5 leading-relaxed">
                      {a.reason}
                    </div>
                  </div>
                  {!a.ok && (
                    <span
                      className="text-[10px] uppercase tracking-[0.08em] font-semibold px-2 py-0.5 rounded"
                      style={{
                        background: "var(--alert-soft)",
                        color: "var(--alert)",
                      }}
                    >
                      Flagged
                    </span>
                  )}
                </li>
              ))}
            </ul>

            {hasMore && (
              <div
                className="mt-3 pt-3 border-t flex items-center justify-between"
                style={{ borderColor: "var(--hairline)" }}
              >
                <span className="text-[11.5px] text-text-tertiary mono">
                  Showing {visible.length} of {total}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setVisibleCount((n) => Math.min(n + PAGE_SIZE, total))
                  }
                  className="text-[12px] uppercase tracking-[0.08em] font-semibold px-3 py-1.5 rounded-[8px] border"
                  style={{
                    borderColor: "var(--hairline)",
                    color: "var(--text-secondary)",
                  }}
                >
                  See more
                </button>
              </div>
            )}
          </>
        )}
      </div>

    </AppShell>
  );
}
