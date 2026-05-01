"use client";

// Live recommendation banner. Polls /api/recommendation every 30s and
// renders only when the engine's recommendation is high-priority —
// i.e. when the user actually needs to act now (charging during a
// stop call, or idle during a start call).
//
// Visual rule under Option B: a single bright "Open Rivian app" CTA.
// The point is the user lands in the Rivian app one tap after seeing
// the banner — no detour through Helios's own settings or any
// confirmation step.
//
// rivianAppUrl is "rivian://" — confirmed working on iOS. On non-iOS
// the link falls through; that's acceptable since the user will be on
// their phone the vast majority of the time the banner matters.

import useSWR from "swr";

import type { RecommendationResponse } from "@/app/api/recommendation/route";

const fetcher = (url: string) =>
  fetch(url).then((r) => r.json() as Promise<RecommendationResponse>);

export function RecommendationBanner() {
  const { data } = useSWR<RecommendationResponse>(
    "/api/recommendation",
    fetcher,
    {
      // 30s while the dashboard is in the foreground. Lighter than the
      // cron's 5-min cadence; heavier than nothing — the banner exists
      // exactly to compress the gap between "engine knows" and "user
      // sees."
      refreshInterval: 30 * 1000,
      revalidateOnFocus: true,
    },
  );

  if (!data) return null;
  if (data.stale) return null; // never surface against non-live data
  if (data.priority !== "high") return null;
  if (data.kind === "noop") return null;

  return (
    <div
      className="mb-3 flex items-center gap-3 rounded-2xl border px-4 py-3"
      style={{
        background: "var(--surface-inset)",
        borderColor: "var(--accent-warm, #DB7507)",
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold text-text-primary">
          {data.title}
        </div>
        <div className="text-[12px] text-text-secondary mt-0.5 leading-relaxed">
          {data.body}
        </div>
      </div>
      <a
        href={data.rivianAppUrl}
        className="shrink-0 text-[13px] font-medium px-3 py-1.5 rounded-lg border"
        style={{
          background: "var(--accent-warm, #DB7507)",
          borderColor: "var(--accent-warm, #DB7507)",
          color: "white",
        }}
      >
        Open Rivian app
      </a>
    </div>
  );
}
