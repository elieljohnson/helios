"use client";

import useSWR from "swr";
import { Card } from "@/components/Card";
import { WeatherIcon } from "@/components/WeatherIcon";
import { useStatus } from "@/lib/useStatus";
import type { ForecastResponse } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json() as Promise<ForecastResponse>);

/** Current hour-of-day in PT (0..23). Used to align the home_curve
 *  (indexed by hour-of-day) with the forecast bars (indexed by hours
 *  from now). On Vercel the server runs UTC, so we must use Intl. */
function ptHourNow(): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hour12: false,
      timeZone: "America/Los_Angeles",
    }).format(new Date()),
    10,
  );
}

export function ForecastCard() {
  const { data } = useSWR<ForecastResponse>("/api/forecast", fetcher, {
    refreshInterval: 60 * 60 * 1000,
  });
  // Pull home_curve off the same status object the rest of the dashboard
  // uses — keeps polling cadence aligned and avoids a separate fetch.
  const status = useStatus();
  const homeCurve = status.data?.home_curve;

  if (!data) return <Card signal="var(--grid)" label="Forecast">{null}</Card>;

  const max = Math.max(...data.hourly.map((h) => h.solar));
  const today = data.daily[0];

  // Align home_curve (indexed 0..23 by hour-of-day) to the forecast's
  // "now → +24h" axis. Bar i corresponds to hour (ptHourNow() + i) % 24.
  // We render the line on the same y-scale as the solar bars (max
  // solar) so the visual relationship "is solar > home demand?" is
  // immediately legible. The line will sit low because home demand
  // peaks ~3 kW vs. solar peaks ~9.5 kW — that's the correct picture.
  const hour0 = ptHourNow();
  const homeAligned = homeCurve
    ? data.hourly.map((_, i) => homeCurve[(hour0 + i) % 24] ?? 0)
    : null;

  return (
    <Card signal="var(--grid)" label="Forecast">
      <div className="flex items-baseline gap-2.5 mb-4">
        <span className="h-hero text-text-primary" style={{ fontSize: 44 }}>
          {today.kwh}
        </span>
        <span className="text-[15px] text-text-secondary">kWh forecast today</span>
        <span className="ml-auto text-solar">
          <WeatherIcon name={today.icon} size={22} />
        </span>
      </div>

      <div className="relative h-12 mb-2.5">
        <div className="absolute inset-0 flex items-end gap-[1px]">
          {data.hourly.map((h, i) => (
            <div
              key={i}
              className="flex-1 rounded-t-[2px]"
              style={{
                height: `${max ? (h.solar / max) * 100 : 2}%`,
                minHeight: 2,
                background: "var(--solar-soft)",
              }}
            />
          ))}
        </div>
        {homeAligned && max > 0 && (
          <svg
            className="absolute inset-0 w-full h-full"
            preserveAspectRatio="none"
            viewBox="0 0 100 48"
          >
            <path
              d={`M 0 ${48 - (homeAligned[0] / max) * 48} ${homeAligned
                .map((kw, i) => `L ${(i / 23) * 100} ${48 - (kw / max) * 48}`)
                .join(" ")}`}
              fill="none"
              stroke="var(--home)"
              strokeWidth="1.25"
              strokeDasharray="3 2"
              opacity="0.85"
            />
          </svg>
        )}
      </div>

      <div className="flex justify-between text-[10px] text-text-tertiary mono">
        <span>NOW</span>
        <span>+6h</span>
        <span>+12h</span>
        <span>+18h</span>
        <span>+24h</span>
      </div>

      {homeAligned && (
        <div className="mt-2 flex gap-3 text-[10px] text-text-tertiary">
          <span className="inline-flex items-center gap-1.5">
            <span
              className="w-[10px] h-[2px] rounded-[1px]"
              style={{ background: "var(--solar-soft)" }}
            />
            Solar forecast
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              className="w-[10px] h-[2px] rounded-[1px]"
              style={{
                background: "var(--home)",
                outline: "0.5px dashed var(--home)",
              }}
            />
            Home demand (avg)
          </span>
        </div>
      )}

      <div className="mt-4 pt-4 border-t border-hairline">
        <div className="flex gap-1.5">
          {data.daily.map((d) => (
            <div key={d.day} className="flex-1 text-center">
              <div className="text-[10px] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
                {d.day}
              </div>
              <div className="my-1.5 text-solar flex justify-center">
                <WeatherIcon name={d.icon} size={18} />
              </div>
              <div className="mono text-[11px] text-text-primary">{d.kwh}</div>
              <div className="text-[9px] text-text-tertiary">kWh</div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
