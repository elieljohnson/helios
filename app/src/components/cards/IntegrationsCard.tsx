"use client";

// Live integrations panel. Each provider lights up green when configured,
// amber when credentials are present but the user hasn't completed OAuth
// yet, gray when server credentials are missing, and red on a runtime
// error. Connect/Disconnect actions hit /api/auth/<provider>.

import { useEffect, useState } from "react";
import useSWR, { mutate as globalMutate } from "swr";

type ProviderState = "configured" | "creds-missing" | "not-connected" | "error";

type ProviderStatus = {
  provider: "enphase" | "smartcar" | "tesla";
  state: ProviderState;
  system_id?: string;
  last_check?: string;
  current_power_w?: number;
  pw_soc?: number;
  pw_reserve?: number;
  message?: string;
};

type IntegrationsResponse = {
  enphase: ProviderStatus;
  smartcar: ProviderStatus;
  tesla: ProviderStatus;
};

const fetcher = (url: string) =>
  fetch(url).then((r) => r.json() as Promise<IntegrationsResponse>);

export function IntegrationsCard() {
  const { data, isLoading } = useSWR<IntegrationsResponse>(
    "/api/integrations",
    fetcher,
    { refreshInterval: 60 * 1000 },
  );

  // Capture ?enphase=connected | ?enphase=error&reason=… from the OAuth
  // callback so we can show a brief banner.
  const [banner, setBanner] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const handleResult = (provider: "enphase" | "tesla") => {
      const result = params.get(provider);
      if (!result) return;
      if (result === "connected") {
        setBanner({ tone: "ok", text: `${labelFor(provider)} connected.` });
      } else if (result === "error") {
        const reason = params.get("reason") ?? "unknown";
        setBanner({
          tone: "error",
          text: `${labelFor(provider)} connect failed: ${reason}`,
        });
      }
      const url = new URL(window.location.href);
      url.searchParams.delete(provider);
      url.searchParams.delete("reason");
      window.history.replaceState({}, "", url.toString());
      globalMutate("/api/integrations");
      globalMutate("/api/status");
      globalMutate("/api/preview-decision");
    };
    handleResult("enphase");
    handleResult("tesla");
  }, []);

  return (
    <section className="h-card">
      <div className="h-card-head">
        <span className="label" style={{ color: "var(--text-secondary)" }}>
          Integrations
        </span>
      </div>

      {banner && (
        <div
          className="mb-3 px-3 py-2 rounded-[12px] text-[12px] border"
          style={{
            background: banner.tone === "ok" ? "rgba(47,174,122,0.08)" : "rgba(210,114,46,0.08)",
            color: banner.tone === "ok" ? "var(--battery)" : "var(--alert)",
            borderColor: "var(--hairline)",
          }}
        >
          {banner.text}
        </div>
      )}

      {isLoading || !data ? (
        <div className="text-text-tertiary text-[13px] mono">loading…</div>
      ) : (
        <ul className="space-y-3">
          <ProviderRow
            name="Enphase Enlighten v4"
            status={data.enphase}
            connectHref="/api/auth/enphase"
          />
          <ProviderRow
            name="Tesla Fleet API"
            status={data.tesla}
            connectHref="/api/auth/tesla"
          />
          <ProviderRow
            name="Rivian (via Smartcar)"
            status={data.smartcar}
            disabled
          />
        </ul>
      )}

      <p className="text-[12px] text-text-tertiary mt-4 leading-relaxed">
        Open-Meteo is keyless and always on. Each provider here overlays
        real data onto the snapshot when connected.
      </p>
    </section>
  );
}

function ProviderRow({
  name,
  status,
  connectHref,
  disabled,
}: {
  name: string;
  status: ProviderStatus;
  connectHref?: string;
  disabled?: boolean;
}) {
  const dotColor = {
    configured: "var(--battery)",
    "not-connected": "var(--solar)",
    "creds-missing": "var(--text-tertiary)",
    error: "var(--alert)",
  }[status.state];

  const stateText = {
    configured: "connected",
    "not-connected": "not connected",
    "creds-missing": "credentials missing",
    error: "error",
  }[status.state];

  return (
    <li>
      <div className="flex items-center gap-2.5 justify-between">
        <span className="inline-flex items-center gap-2 text-text-primary text-[13px]">
          <span
            className="w-[8px] h-[8px] rounded-full"
            style={{ background: dotColor }}
          />
          {name}
        </span>
        <ActionButton
          status={status}
          connectHref={connectHref}
          disabled={disabled}
          stateText={stateText}
        />
      </div>
      <ProviderDetail status={status} />
    </li>
  );
}

function ActionButton({
  status,
  connectHref,
  disabled,
  stateText,
}: {
  status: ProviderStatus;
  connectHref?: string;
  disabled?: boolean;
  stateText: string;
}) {
  const [busy, setBusy] = useState(false);

  if (disabled) {
    return (
      <span className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary font-semibold">
        {stateText}
      </span>
    );
  }

  if (status.state === "configured") {
    return (
      <button
        type="button"
        onClick={async () => {
          setBusy(true);
          await fetch(`/api/auth/${status.provider}`, { method: "DELETE" });
          await globalMutate("/api/integrations");
          await globalMutate("/api/status");
          await globalMutate("/api/preview-decision");
          setBusy(false);
        }}
        disabled={busy}
        className="text-[11px] uppercase tracking-[0.08em] font-semibold px-3 py-1 rounded-[8px] border"
        style={{ borderColor: "var(--hairline)", color: "var(--text-secondary)" }}
      >
        {busy ? "…" : "disconnect"}
      </button>
    );
  }

  if (status.state === "creds-missing") {
    return (
      <span className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary font-semibold">
        credentials missing
      </span>
    );
  }

  // not-connected | error → Connect / Reconnect link
  if (!connectHref) {
    return (
      <span className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary font-semibold">
        {stateText}
      </span>
    );
  }
  return (
    <a
      href={connectHref}
      className="text-[11px] uppercase tracking-[0.08em] font-semibold px-3 py-1 rounded-[8px]"
      style={{ background: "var(--text-primary)", color: "var(--surface-card)" }}
    >
      {status.state === "error" ? "reconnect" : "connect"}
    </a>
  );
}

function ProviderDetail({ status }: { status: ProviderStatus }) {
  // Configured: show provider-appropriate detail strip.
  if (status.state === "configured") {
    const bits: string[] = [];
    if (status.system_id) bits.push(`site ${status.system_id}`);

    if (status.provider === "tesla") {
      if (status.pw_soc != null) bits.push(`SoC ${status.pw_soc}%`);
      if (status.pw_reserve != null) bits.push(`reserve ${status.pw_reserve}%`);
      if (status.current_power_w != null) {
        const kw = status.current_power_w / 1000;
        const sign = kw >= 0 ? "+" : "";
        bits.push(`${sign}${kw.toFixed(2)} kW PW`);
      }
    } else if (status.current_power_w != null) {
      bits.push(`${(status.current_power_w / 1000).toFixed(2)} kW now`);
    }

    if (status.last_check) {
      bits.push(
        `checked ${new Date(status.last_check).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        })}`,
      );
    }
    if (!bits.length) return null;
    return (
      <div className="text-[11px] text-text-tertiary mono mt-1 ml-[16px]">
        {bits.join(" · ")}
      </div>
    );
  }

  if (status.state === "creds-missing") {
    return (
      <div className="text-[11px] text-text-tertiary mt-1 ml-[16px] leading-relaxed">
        Add credentials to the server env vars, then redeploy.
      </div>
    );
  }

  if (status.state === "error" && status.message) {
    return (
      <div
        className="text-[11px] mt-1 ml-[16px] leading-relaxed"
        style={{ color: "var(--alert)" }}
      >
        {status.message}
      </div>
    );
  }

  if (status.state === "not-connected") {
    return (
      <div className="text-[11px] text-text-tertiary mt-1 ml-[16px] leading-relaxed">
        OAuth flow not yet completed.
      </div>
    );
  }

  return null;
}

function labelFor(provider: "enphase" | "tesla"): string {
  return provider === "enphase" ? "Enphase" : "Tesla";
}
