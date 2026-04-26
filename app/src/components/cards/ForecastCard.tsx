"use client";

import useSWR from "swr";
import { Card } from "@/components/Card";
import { WeatherIcon } from "@/components/WeatherIcon";
import type { ForecastResponse } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => r.json() as Promise<ForecastResponse>);

export function ForecastCard() {
  const { data } = useSWR<ForecastResponse>("/api/forecast", fetcher, {
    refreshInterval: 60 * 60 * 1000,
  });

  if (!data) return <Card signal="var(--grid)" label="Forecast">{null}</Card>;

  const max = Math.max(...data.hourly.map((h) => h.solar));
  const today = data.daily[0];

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
        <svg
          className="absolute inset-0 w-full h-full"
          preserveAspectRatio="none"
          viewBox="0 0 100 48"
        >
          <path
            d={`M 0 ${48 - data.hourly[0].cloud * 0.45} ${data.hourly
              .map((d, i) => `L ${(i / 23) * 100} ${48 - d.cloud * 0.45}`)
              .join(" ")}`}
            fill="none"
            stroke="var(--grid)"
            strokeWidth="1"
            strokeDasharray="2 2"
            opacity="0.6"
          />
        </svg>
      </div>

      <div className="flex justify-between text-[10px] text-text-tertiary mono">
        <span>NOW</span>
        <span>+6h</span>
        <span>+12h</span>
        <span>+18h</span>
        <span>+24h</span>
      </div>

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
