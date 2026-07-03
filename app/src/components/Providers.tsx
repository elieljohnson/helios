"use client";

import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { localStorageProvider } from "@/lib/swrPersistence";
import { ThemeProvider } from "@/lib/theme";

/**
 * Client-side providers mounted at the root of every page tree.
 *
 * SWRConfig provider: localStorage-backed cache so the dashboard
 * renders the last-known state instantly on PWA cold starts (the
 * OS kills the background process; without persistence we'd show
 * "loading…" for the 1-2s of the first /api/status round-trip).
 * See lib/swrPersistence.ts for the full rationale.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <SWRConfig value={{ provider: localStorageProvider }}>{children}</SWRConfig>
    </ThemeProvider>
  );
}
