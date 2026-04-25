"use client";

import { AppShell } from "@/components/AppShell";
import { useStatus } from "@/lib/useStatus";

export default function SettingsPage() {
  const { data } = useStatus();
  const system = data?.system;

  return (
    <AppShell location={system?.location} utility={system?.utility}>
      <div className="mb-4 px-2">
        <h1 className="text-[22px] font-semibold text-text-primary">Settings</h1>
        <p className="text-[13px] text-text-secondary mt-1">
          System configuration. Integrations arrive with the backend — Enphase first.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <section className="h-card">
          <div className="h-card-head">
            <span className="label" style={{ color: "var(--text-secondary)" }}>System</span>
          </div>
          {system ? (
            <dl className="grid grid-cols-2 gap-3 text-[13px]">
              <Row label="Location" value={system.location} />
              <Row label="Utility" value={system.utility} />
              <Row label="Solar" value={`${system.solar.count}× ${system.solar.model}`} sub={`${system.solar.peak} kW peak`} />
              <Row label="Battery" value={`${system.battery.count}× ${system.battery.model}`} sub={`${system.battery.total} kWh`} />
              <Row label="Vehicle" value={system.vehicle.model} sub={`${system.vehicle.capacity} kWh · ${system.vehicle.max_charge} kW max`} />
            </dl>
          ) : (
            <span className="text-text-tertiary text-[13px] mono">loading…</span>
          )}
        </section>

        <section className="h-card">
          <div className="h-card-head">
            <span className="label" style={{ color: "var(--text-secondary)" }}>Integrations</span>
          </div>
          <ul className="text-[13px] space-y-2">
            <Integration name="Enphase Enlighten v4" status="pending" />
            <Integration name="Tesla Fleet API" status="pending" />
            <Integration name="Rivian" status="pending" />
            <Integration name="Open-Meteo" status="pending" />
          </ul>
          <p className="text-[12px] text-text-tertiary mt-4 leading-relaxed">
            OAuth flows land with the backend milestone. Until then, the UI reads from a mocked
            snapshot matching the &ldquo;optimized&rdquo; scenario.
          </p>
        </section>
      </div>
    </AppShell>
  );
}

function Row({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.1em] text-text-tertiary">{label}</dt>
      <dd className="mt-1 font-medium text-text-primary">{value}</dd>
      {sub && <dd className="text-[11px] text-text-tertiary mono">{sub}</dd>}
    </div>
  );
}

function Integration({ name, status }: { name: string; status: "connected" | "pending" | "error" }) {
  const color =
    status === "connected" ? "var(--battery)" : status === "error" ? "var(--alert)" : "var(--text-tertiary)";
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
