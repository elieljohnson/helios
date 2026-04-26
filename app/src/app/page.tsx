"use client";

import { AppShell } from "@/components/AppShell";
import { HeroCard } from "@/components/cards/HeroCard";
import { SolarCard } from "@/components/cards/SolarCard";
import { EVCard } from "@/components/cards/EVCard";
import { PowerwallCard } from "@/components/cards/PowerwallCard";
import { CostCard } from "@/components/cards/CostCard";
import { ForecastCard } from "@/components/cards/ForecastCard";
import { useStatus } from "@/lib/useStatus";

export default function Home() {
  const { data, error, isLoading } = useStatus();

  if (isLoading) {
    return (
      <AppShell>
        <span className="text-text-tertiary text-[15px] mono">loading…</span>
      </AppShell>
    );
  }
  if (error || !data) {
    return (
      <AppShell>
        <span className="text-alert text-[15px] mono">failed to load /api/status</span>
      </AppShell>
    );
  }

  return (
    <AppShell location={data.system.location} utility={data.system.utility}>
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
