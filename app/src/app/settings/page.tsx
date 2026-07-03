"use client";

import useSWR, { mutate as globalMutate } from "swr";
import { AppShell } from "@/components/AppShell";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { AutomationToggle } from "@/components/cards/AutomationToggle";
import { EvPolicyForm } from "@/components/cards/EvPolicyForm";
import { IntegrationsCard } from "@/components/cards/IntegrationsCard";
import { LiveDecisionCard } from "@/components/cards/LiveDecisionCard";
import { NotificationsCard } from "@/components/cards/NotificationsCard";
import { ThemeControl } from "@/components/ThemeControl";
import { useAdmin } from "@/lib/useAdmin";
import { useStatus, useVisibilityRefresh } from "@/lib/useStatus";
import type { ConfigResponse } from "@/lib/types";

const fetcher = (url: string) =>
  fetch(url).then((r) => r.json() as Promise<ConfigResponse>);

export default function SettingsPage() {
  const { data: status, isValidating } = useStatus();
  useVisibilityRefresh();
  const system = status?.system;
  const { admin, signOut } = useAdmin();

  const { data: config, mutate: mutateConfig } = useSWR<ConfigResponse>(
    "/api/config",
    fetcher,
  );

  return (
    <AppShell
      location={system?.location}
      utility={system?.utility}
      freshness={{ timestamp: status?.timestamp, isValidating }}
      health={
        status
          ? {
              sources: status.sources,
              assembly_errors: status.assembly_errors,
            }
          : undefined
      }
    >
      <div className="mb-4 px-2 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold text-text-primary">Settings</h1>
          <p className="text-[15px] text-text-secondary mt-1">
            Tune the decision engine, watch the rules respond in real
            time, and choose how Helios pings you when the EV needs
            attention.
          </p>
        </div>
        {admin && (
          <button
            type="button"
            onClick={signOut}
            className="shrink-0 text-[12px] uppercase tracking-[0.06em] text-text-tertiary hover:text-text-secondary px-2 py-1"
          >
            sign out
          </button>
        )}
      </div>

      {!admin && <ReadOnlyBanner />}

      {/* Master pause switch — sits above both columns so it's the first
          thing the eye lands on. Spans full width since the paused state
          is loud and we want it impossible to miss. */}
      {config && (
        <div className="mb-3">
          <AutomationToggle
            config={config}
            readOnly={!admin}
            onChanged={async (updated) => {
              await mutateConfig(updated, false);
              await globalMutate("/api/preview-decision");
            }}
          />
        </div>
      )}

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
              readOnly={!admin}
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
              <span className="label">Appearance</span>
            </div>
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <p className="text-[14px] text-text-secondary max-w-[34ch]">
                Follow your device, or lock Helios to light or dark.
                Saved on this device.
              </p>
              <ThemeControl />
            </div>
          </section>

          <section className="h-card">
            <div className="h-card-head">
              <span className="label">
                System
              </span>
            </div>
            {system ? (
              <dl className="grid grid-cols-2 gap-3 text-[15px]">
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

          <IntegrationsCard readOnly={!admin} />

          <NotificationsCard />
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

