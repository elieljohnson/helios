"use client";

import { useEffect, useState } from "react";

import { AppShell } from "@/components/AppShell";
import { DashboardSkeleton } from "@/components/DashboardSkeleton";
import { HeroCard } from "@/components/cards/HeroCard";
import { SolarCard } from "@/components/cards/SolarCard";
import { EVCard } from "@/components/cards/EVCard";
import { PowerwallCard } from "@/components/cards/PowerwallCard";
import { CostCard } from "@/components/cards/CostCard";
import { ForecastCard } from "@/components/cards/ForecastCard";
import { RecommendationBanner } from "@/components/cards/RecommendationBanner";
import { useStatus, useVisibilityRefresh } from "@/lib/useStatus";

export default function Home() {
  const { data, error, isLoading, isValidating } = useStatus();
  // Re-fetch every key the moment the PWA comes back to foreground.
  // Safe to mount on every page that wants this behavior — useEffect
  // attaches one listener per mount; React's hook discipline keeps it
  // from compounding.
  useVisibilityRefresh();

  // Hydration guard. SWR's first-render state can diverge between SSR
  // and client (especially in dev with HMR / cache replay / browser
  // extensions injecting into the DOM), causing React #418 hydration
  // errors when the loading branch and error branch swap places between
  // server and client. Pinning the first paint to a single deterministic
  // skeleton on both server AND first client render — and only branching
  // after `useEffect` flips `mounted` — guarantees parity. The visible
  // cost is one extra paint cycle on initial load, which is invisible
  // since SWR usually has data ready before the next frame anyway.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted || isLoading) {
    return (
      <AppShell>
        <DashboardSkeleton />
      </AppShell>
    );
  }
  if (error || !data) {
    return (
      <AppShell>
        <span className="text-alert text-[13px] mono">failed to load /api/status</span>
      </AppShell>
    );
  }

  return (
    <AppShell
      location={data.system.location}
      utility={data.system.utility}
      freshness={{ timestamp: data.timestamp, isValidating }}
      health={{
        sources: data.sources,
        assembly_errors: data.assembly_errors,
      }}
    >
      <RecommendationBanner />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <HeroCard snapshot={data.snapshot} />
        <CostCard data={data} />
        <SolarCard data={data} />
        <EVCard data={data} />
        <PowerwallCard data={data} />
        <ForecastCard />
      </div>
    </AppShell>
  );
}
