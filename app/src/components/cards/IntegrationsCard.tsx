"use client";

// Live integrations panel. Each provider lights up green when configured,
// amber when credentials are present but the user hasn't completed OAuth
// yet, gray when server credentials are missing, and red on a runtime
// error. Connect/Disconnect actions hit /api/auth/<provider>.

import { useEffect, useState } from "react";
import useSWR, { mutate as globalMutate } from "swr";

type ProviderState = "configured" | "creds-missing" | "not-connected" | "error";

type ProviderStatus = {
  provider: "enphase" | "smartcar" | "tesla" | "rivian";
  state: ProviderState;
  system_id?: string;
  last_check?: string;
  current_power_w?: number;
  pw_soc?: number;
  pw_reserve?: number;
  ev_soc?: number;
  ev_range?: number;
  ev_charging?: boolean;
  ev_plugged_in?: boolean;
  ev_make?: string;
  ev_model?: string;
  message?: string;
};

type IntegrationsResponse = {
  enphase: ProviderStatus;
  smartcar: ProviderStatus;
  tesla: ProviderStatus;
  rivian: ProviderStatus;
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
    const handleResult = (provider: "enphase" | "tesla" | "smartcar") => {
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
    handleResult("smartcar");
  }, []);

  // Inline credential entry for Rivian. Unlike the OAuth providers,
  // Rivian's unofficial API uses email + password directly. We open a
  // small form below the row when the user clicks "connect"; on submit,
  // POST to /api/auth/rivian and refresh the integrations panel.
  const [rivianFormOpen, setRivianFormOpen] = useState(false);

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
            connectHref="/api/auth/smartcar"
          />
          <ProviderRow
            name="Rivian (direct)"
            status={data.rivian}
            onConnect={() => setRivianFormOpen((v) => !v)}
            connectButtonLabel={rivianFormOpen ? "cancel" : "connect"}
          />
          {rivianFormOpen && data.rivian.state !== "configured" && (
            <RivianConnectForm
              onClose={() => setRivianFormOpen(false)}
              onResult={(tone, text) => {
                setBanner({ tone, text });
                if (tone === "ok") setRivianFormOpen(false);
              }}
            />
          )}
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
  onConnect,
  connectButtonLabel,
  disabled,
}: {
  name: string;
  status: ProviderStatus;
  /** OAuth providers: redirect URL on click. Mutually exclusive with onConnect. */
  connectHref?: string;
  /** Non-OAuth providers (Rivian): in-app handler that toggles the
   *  inline credential form. Mutually exclusive with connectHref. */
  onConnect?: () => void;
  /** Override default "connect" / "reconnect" button copy. */
  connectButtonLabel?: string;
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
        <span className="inline-flex items-center gap-2 text-text-primary text-[15px]">
          <span
            className="w-[8px] h-[8px] rounded-full"
            style={{ background: dotColor }}
          />
          {name}
        </span>
        <ActionButton
          status={status}
          connectHref={connectHref}
          onConnect={onConnect}
          connectButtonLabel={connectButtonLabel}
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
  onConnect,
  connectButtonLabel,
  disabled,
  stateText,
}: {
  status: ProviderStatus;
  connectHref?: string;
  onConnect?: () => void;
  connectButtonLabel?: string;
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

  // not-connected | error → Connect / Reconnect button.
  // Two flavors: OAuth providers redirect via connectHref; Rivian uses
  // an in-app form via onConnect.
  const label = connectButtonLabel ?? (status.state === "error" ? "reconnect" : "connect");
  if (onConnect) {
    return (
      <button
        type="button"
        onClick={onConnect}
        className="text-[11px] uppercase tracking-[0.08em] font-semibold px-3 py-1 rounded-[8px]"
        style={{ background: "var(--text-primary)", color: "var(--surface-card)" }}
      >
        {label}
      </button>
    );
  }
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
      {label}
    </a>
  );
}

function ProviderDetail({ status }: { status: ProviderStatus }) {
  // Configured: show provider-appropriate detail strip.
  if (status.state === "configured") {
    const bits: string[] = [];

    if (status.provider === "tesla") {
      if (status.system_id) bits.push(`site ${status.system_id}`);
      if (status.pw_soc != null) bits.push(`SoC ${status.pw_soc}%`);
      if (status.pw_reserve != null) bits.push(`reserve ${status.pw_reserve}%`);
      if (status.current_power_w != null) {
        const kw = status.current_power_w / 1000;
        const sign = kw >= 0 ? "+" : "";
        bits.push(`${sign}${kw.toFixed(2)} kW PW`);
      }
    } else if (status.provider === "smartcar") {
      // Vehicle UUID isn't user-meaningful; surface make/model + SoC instead.
      // If there's no SoC yet (token saved but vehicle data hasn't come
      // through — typically blocked OAuth or first-snapshot pending) we
      // show a soft "data pending" line so the row isn't deceptively
      // green-with-no-detail.
      if (status.ev_make && status.ev_model) {
        bits.push(`${status.ev_make} ${status.ev_model}`);
      }
      if (status.ev_soc != null) bits.push(`SoC ${status.ev_soc}%`);
      if (status.ev_charging != null) {
        bits.push(status.ev_charging ? "charging" : "idle");
      }
      if (status.ev_soc == null) {
        bits.push(status.message ?? "vehicle data pending");
      }
    } else if (status.provider === "rivian") {
      if (status.ev_make && status.ev_model) {
        bits.push(`${status.ev_make} ${status.ev_model}`);
      }
      if (status.ev_soc != null) bits.push(`SoC ${status.ev_soc}%`);
      if (status.ev_range != null) bits.push(`${status.ev_range} mi`);
      if (status.ev_plugged_in === true && status.ev_charging === false) {
        bits.push("plugged in, idle");
      } else if (status.ev_charging === true) {
        bits.push("charging");
      } else if (status.ev_plugged_in === false) {
        bits.push("unplugged");
      }
      if (status.ev_soc == null) {
        bits.push(status.message ?? "vehicle data pending");
      }
    } else {
      if (status.system_id) bits.push(`site ${status.system_id}`);
      if (status.current_power_w != null) {
        bits.push(`${(status.current_power_w / 1000).toFixed(2)} kW now`);
      }
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
        {status.provider === "rivian"
          ? "Click connect to sign in with your Rivian email + password."
          : "OAuth flow not yet completed."}
      </div>
    );
  }

  return null;
}

function labelFor(provider: "enphase" | "tesla" | "smartcar"): string {
  if (provider === "enphase") return "Enphase";
  if (provider === "tesla") return "Tesla";
  return "Rivian";
}

/** Inline credential entry for Rivian. Renders below the row when the
 *  user clicks "connect". POSTs to /api/auth/rivian; on success the
 *  parent banners and refreshes the integrations panel. The password
 *  is sent over HTTPS and discarded server-side immediately after
 *  Rivian returns tokens — never persisted. */
function RivianConnectForm({
  onClose,
  onResult,
}: {
  onClose: () => void;
  onResult: (tone: "ok" | "error", text: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/rivian", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = body.message ?? body.error ?? `HTTP ${r.status}`;
        setError(msg);
        onResult("error", `Rivian connect failed: ${msg}`);
        return;
      }
      const pinned = body.pinned_vehicle ?? "vehicle";
      onResult("ok", `Rivian connected (${pinned}).`);
      await globalMutate("/api/integrations");
      await globalMutate("/api/status");
      await globalMutate("/api/preview-decision");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "network error";
      setError(msg);
      onResult("error", `Rivian connect failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className="ml-[16px] p-3 rounded-[12px] border"
      style={{ borderColor: "var(--hairline)", background: "var(--surface-elevated)" }}
    >
      <form onSubmit={submit} className="space-y-2.5">
        <div className="text-[11px] text-text-tertiary leading-relaxed">
          Helios sends your credentials to Rivian over HTTPS, keeps the
          session token, and discards your password. Same pattern as the
          Home Assistant Rivian integration. 2FA accounts not yet supported.
        </div>
        <input
          type="email"
          autoComplete="username"
          required
          placeholder="rivian email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
          className="w-full px-3 py-2 rounded-[8px] text-[14px] bg-surface-card border"
          style={{ borderColor: "var(--hairline)", color: "var(--text-primary)" }}
        />
        <input
          type="password"
          autoComplete="current-password"
          required
          placeholder="rivian password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
          className="w-full px-3 py-2 rounded-[8px] text-[14px] bg-surface-card border"
          style={{ borderColor: "var(--hairline)", color: "var(--text-primary)" }}
        />
        {error && (
          <div className="text-[11px]" style={{ color: "var(--alert)" }}>
            {error}
          </div>
        )}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy || !email || !password}
            className="text-[11px] uppercase tracking-[0.08em] font-semibold px-3 py-1.5 rounded-[8px]"
            style={{
              background: busy ? "var(--surface-inset)" : "var(--text-primary)",
              color: busy ? "var(--text-tertiary)" : "var(--surface-card)",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "connecting…" : "connect rivian"}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="text-[11px] uppercase tracking-[0.08em] font-semibold px-3 py-1.5 rounded-[8px] border"
            style={{ borderColor: "var(--hairline)", color: "var(--text-secondary)" }}
          >
            cancel
          </button>
        </div>
      </form>
    </li>
  );
}
