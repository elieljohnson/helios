"use client";

import { useEffect } from "react";
import useSWR, { useSWRConfig } from "swr";
import type { StatusResponse } from "./types";

const fetcher = (url: string) => fetch(url).then((r) => r.json() as Promise<StatusResponse>);

const STATUS_KEY = "/api/status";

/**
 * Status hook with PWA-aware freshness behavior.
 *
 *   - Polls every 5 minutes (matches cron cadence)
 *   - revalidateOnFocus: SWR's window.focus signal (works in some
 *     browser contexts but is unreliable in standalone PWAs where the
 *     focus event doesn't fire on app reactivation)
 *   - useVisibilityRefresh below adds the document.visibilityState
 *     handler that DOES fire on PWA wake — refetching the moment the
 *     user re-opens the app from the home screen.
 *
 * Together these give the user "freshest data on every visible
 * impression" without burning bandwidth while the app is backgrounded.
 */
export function useStatus() {
  return useSWR<StatusResponse>(STATUS_KEY, fetcher, {
    refreshInterval: 5 * 60 * 1000,
    revalidateOnFocus: true,
  });
}

/**
 * Mount this once near the app root. When the browser tab becomes
 * visible (PWA reactivation, switching back from another tab, unlocking
 * the phone with the app already open), it triggers a global SWR
 * revalidation across every key the app has subscribed to.
 *
 * Why not rely on SWR's revalidateOnFocus alone: in standalone PWAs
 * the `focus` event does not fire reliably when the app returns from
 * background. `visibilitychange` does. Using both = belt + suspenders.
 *
 * Why global mutate: the dashboard subscribes to /api/status,
 * /api/forecast, /api/integrations, /api/me. Calling mutate(undefined)
 * with no key invalidates ALL of them at once.
 */
export function useVisibilityRefresh() {
  const { mutate } = useSWRConfig();
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        // Mutate with `undefined` (no key) revalidates every active
        // SWR subscription. The argument controls deduping; we want
        // the network to fire so pass `undefined` data + revalidate.
        mutate(() => true, undefined, { revalidate: true });
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [mutate]);
}
