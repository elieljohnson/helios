"use client";

import useSWR, { mutate as globalMutate } from "swr";
import { AppShell } from "@/components/AppShell";
import { EvPolicyForm } from "@/components/cards/EvPolicyForm";
import { LiveDecisionCard } from "@/components/cards/LiveDecisionCard";
import { useStatus } from "@/lib/useStatus";
import type { ConfigResponse } from "@/lib/types";

const fetcher = (url: string) =>
  fetch(url).then((r) => r.json() as Promise<ConfigResponse>);

export default function SettingsPage() {
  const { data: status } = useStatus();
  const system = status?.system;

  const { data: config, mutate: mutateConfig } = useSWR<ConfigResponse>(
    "/api/config",
    fetcher,
  );

  return (
    <AppShell location={system?.location} utility={system?.utility}>
      <div className="mb-4 px-2">
        <h1 className="text-[22px] font-semibold text-text-primary">Settings</h1>
        <p className="text-[13px] text-text-secondary mt-1">
          Tune the decision engine and watch the rules respond in real time.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
        {/* Left column: live decision (always-on simulator) */}
        <div className="space-y-3">
          <LiveDecisionCard />
        </div>

        {/* Right column: editable policy + system context */}
        <div className="space-y-3">
          {config ? (
            <EvPolicyForm
              config={config}
              onSaved={async (updated) => {
                // Sync /api/config cache to the saved value, then revalidate
                // /api/preview-decision so the left column re-runs the
                // engines with the new policy.
                await mutateConfig(updated, false);
                await globalMutate("/api/preview-decision");
              }}
            />
          ) : (
            <div className="h-card text-text-tertiary text-[13px] mono">
              loading config…
            </div>
          )}

          <section className="h-card">
            <div className="h-card-head">
              <span
                className="label"
                style={{ color: "var(--text-secondary)" }}
              >
                System
              </span>
            </div>
            {system ? (
              <dl className="grid grid-cols-2 gap-3 text-[13px]">
                <Row label="Location" value={system.location} />
                <Row label="Utility" value={system.utility} />
                <Row
                  label="Solar"
                  value={`${system.solar.count}× ${system.solar.model}`}
                  sub={`${system.solar.peak} kW peak`}
                />
                <Row
                  label="Battery"
                  value={`${system.battery.count}× ${system.battery.model}`}
                  sub={`${system.battery.total} kWh`}
                />
                <Row
                  label="Vehicle"
                  value={system.vehicle.model}
                  sub={`${system.vehicle.capacity} kWh · ${system.vehicle.max_charge} kW max`}
                />
              </dl>
            ) : (
              <span className="text-text-tertiary text-[13px] mono">loading…</span>
            )}
          </section>

          <section className="h-card">
            <div className="h-card-head">
              <span
                className="label"
                style={{ color: "var(--text-secondary)" }}
              >
                Integrations
              </span>
            </div>
            <ul className="text-[13px] space-y-2">
              <Integration name="Open-Meteo" status="connected" />
              <Integration name="Enphase Enlighten v4" status="pending" />
              <Integration name="Tesla Fleet API" status="pending" />
              <Integration name="Rivian" status="pending" />
            </ul>
            <p className="text-[12px] text-text-tertiary mt-4 leading-relaxed">
              Enphase OAuth lands first. Until then, the snapshot is mocked
              against the validated &ldquo;optimized&rdquo; scenario.
            </p>
          </section>
        </div>
      </div>
    </AppShell>
  );
}

function Row({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.1em] text-text-tertiary">
        {label}
      </dt>
      <dd className="mt-1 font-medium text-text-primary">{value}</dd>
      {sub && <dd className="text-[11px] text-text-tertiary mono">{sub}</dd>}
    </div>
  );
}

function Integration({
  name,
  status,
}: {
  name: string;
  status: "connected" | "pending" | "error";
}) {
  const color =
    status === "connected"
      ? "var(--battery)"
      : status === "error"
        ? "var(--alert)"
        : "var(--text-tertiary)";
  return (
    <li className="flex items-center gap-2.5 justify-between">
      <span className="inline-flex items-center gap-2 text-text-primary">
        <span
          className="w-[8px] h-[8px] rounded-full"
          style={{ background: color }}
        />
        {name}
      </span>
      <span className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary font-semibold">
        {status}
      </span>
    </li>
  );
}
