"use client";

import useSWR from "swr";
import type { StatusResponse } from "./types";

const fetcher = (url: string) => fetch(url).then((r) => r.json() as Promise<StatusResponse>);

export function useStatus() {
  // 5-min staleness matches the backend cron cadence from the PRD.
  return useSWR<StatusResponse>("/api/status", fetcher, {
    refreshInterval: 5 * 60 * 1000,
    revalidateOnFocus: true,
  });
}
