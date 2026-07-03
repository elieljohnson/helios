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

type IntegrationsCardProps = {
  /** When true, all connect/disconnect controls are disabled. Used by the
   *  public demo so visitors can see provider state without modifying it.
   *  Server-side proxy.ts is the actual gate; this is UX. */
  readOnly?: boolean;
};

export function IntegrationsCard({ readOnly }: IntegrationsCardProps = {}) {
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
        <span className="label">
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
            disabled={readOnly}
          />
          <ProviderRow
            name="Tesla Fleet API"
            status={data.tesla}
            connectHref="/api/auth/tesla"
            disabled={readOnly}
          />
          {/* Smartcar V3 + Rivian-direct are read-only under Option B
              (locked 2026-05-01). Both API surfaces returned
              DEVICE_PAIRING_REQUIRED on live test; Gen 2 R1S uses Apple
              Car Key, which can't be initiated from any non-Apple-
              enclave device. See the read-only callout below. */}
          <ProviderRow
            name="Rivian (via Smartcar)"
            scope="read-only"
            status={data.smartcar}
            connectHref="/api/auth/smartcar"
            disabled={readOnly}
          />
          <ProviderRow
            name="Rivian (direct)"
            scope="read-only"
            status={data.rivian}
            onConnect={() => setRivianFormOpen((v) => !v)}
            connectButtonLabel={rivianFormOpen ? "cancel" : "connect"}
            disabled={readOnly}
          />
          {!readOnly && rivianFormOpen && data.rivian.state !== "configured" && (
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

      <details
        className="mt-3 text-[12px] text-text-tertiary leading-relaxed"
        style={{ borderTop: "1px solid var(--hairline)", paddingTop: 10 }}
      >
        <summary
          className="cursor-pointer text-text-secondary"
          style={{ fontWeight: 500 }}
        >
          Why are the Rivian rows read-only?
        </summary>
        <p className="mt-2">
          The 2025 R1S (Gen 2) uses Apple Car Key for phone-key authority,
          and Apple Car Key can&apos;t be initiated from any non-Apple-
          secure-enclave device. Both Rivian&apos;s unofficial cloud API
          and Smartcar V3&apos;s commands return{" "}
          <span className="mono">DEVICE_PAIRING_REQUIRED</span>; a local
          BLE spike found no Rivian peripheral broadcasting at all. So
          Helios reads vehicle state from both providers but actuates
          nothing — instead, the dashboard banner and Web Push
          recommendations point you at the Rivian app, which has the
          paired credential.
        </p>
        <p className="mt-2">
          The decision engine itself is provider-agnostic. If the user
          ever switches to a Tesla (or any non-Apple-Car-Key vehicle
          surface), only the actuator layer would change.
        </p>
      </details>
    </section>
  );
}

function ProviderRow({
  name,
  scope,
  status,
  connectHref,
  onConnect,
  connectButtonLabel,
  disabled,
}: {
  name: string;
  /** Inline scope label rendered next to the provider name. Used to
   *  flag read-only providers under Option B so the row's green dot
   *  ("connected") doesn't mislead — the green is honest about reads
   *  succeeding, the label is honest about writes being unavailable. */
  scope?: "read-only";
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
      <div className="flex items-start gap-2.5 justify-between">
        <div className="flex flex-col gap-1.5 min-w-0 flex-1">
          <span className="inline-flex items-center gap-2 text-text-primary text-[15px]">
            <span
              className="w-[8px] h-[8px] rounded-full shrink-0"
              style={{ background: dotColor }}
            />
            <span className="leading-snug">{name}</span>
          </span>
          {/* Badge on its own line below the provider name. Inline
              alignment wrapped awkwardly on long names ("Rivian (via
              Smartcar)") — vertical stack reads cleaner and gives the
              badge consistent positioning across rows. */}
          {scope === "read-only" && (
            <span
              className="self-start text-[10px] uppercase tracking-[0.08em] px-1.5 py-0.5 rounded font-semibold"
              style={{
                background: "var(--surface-card)",
                color: "var(--text-tertiary)",
                border: "1px solid var(--hairline)",
              }}
            >
              read-only
            </span>
          )}
        </div>
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

/** Two-step inline connect for Rivian.
 *
 *  Step 1: email + password → POST /api/auth/rivian/start.
 *    - Non-MFA: server saves tokens directly, banner + close.
 *    - MFA: server sets HTTP-only cookie with otpToken+csrf and
 *      returns { mfa_required: true }; UI flips to step 2.
 *
 *  Step 2: OTP code → POST /api/auth/rivian/otp.
 *    - Server reads cookie, calls submitOtp, persists tokens.
 *
 *  Rivian challenges every new IP/device with an OTP, so MFA path is
 *  the common case. The password never touches local storage / cookies
 *  — it lives in component state until step 1 succeeds, then is
 *  cleared. The OTP cookie is httpOnly + sameSite=lax + 5-min TTL. */
function RivianConnectForm({
  onClose,
  onResult,
}: {
  onClose: () => void;
  onResult: (tone: "ok" | "error", text: string) => void;
}) {
  const [step, setStep] = useState<"creds" | "otp">("creds");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStreams = async () => {
    await globalMutate("/api/integrations");
    await globalMutate("/api/status");
    await globalMutate("/api/preview-decision");
  };

  const submitCreds = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/rivian/start", {
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
      if (body.mfa_required) {
        // Discard password from component state — server has the
        // otpToken cookie now; we won't need the password again.
        setPassword("");
        setStep("otp");
        return;
      }
      // Non-MFA path — direct success
      const pinned = body.pinned_vehicle ?? "vehicle";
      onResult("ok", `Rivian connected (${pinned}).`);
      await refreshStreams();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "network error";
      setError(msg);
      onResult("error", `Rivian connect failed: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const submitOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/rivian/otp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ otp_code: otpCode }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = body.message ?? body.error ?? `HTTP ${r.status}`;
        setError(msg);
        // 410 means cookie expired — bounce back to step 1
        if (r.status === 410) {
          setStep("creds");
          setOtpCode("");
        }
        return;
      }
      const pinned = body.pinned_vehicle ?? "vehicle";
      onResult("ok", `Rivian connected (${pinned}).`);
      await refreshStreams();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "network error";
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className="ml-[16px] p-3 rounded-[12px] border"
      style={{ borderColor: "var(--hairline)", background: "var(--surface-elevated)" }}
    >
      {step === "creds" ? (
        <form onSubmit={submitCreds} className="space-y-2.5">
          <div className="text-[11px] text-text-tertiary leading-relaxed">
            Helios sends your credentials to Rivian over HTTPS, keeps the
            session token, and discards your password. Same pattern as the
            Home Assistant Rivian integration. Rivian will email you a
            6-digit OTP to confirm this is you.
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
      ) : (
        <form onSubmit={submitOtp} className="space-y-2.5">
          <div className="text-[11px] text-text-tertiary leading-relaxed">
            Rivian sent a 6-digit code to {email || "your email"}. Enter
            it within 5 minutes.
          </div>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            placeholder="6-digit code"
            value={otpCode}
            onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ""))}
            disabled={busy}
            maxLength={8}
            className="w-full px-3 py-2 rounded-[8px] text-[16px] mono tracking-[0.2em] bg-surface-card border"
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
              disabled={busy || otpCode.length < 4}
              className="text-[11px] uppercase tracking-[0.08em] font-semibold px-3 py-1.5 rounded-[8px]"
              style={{
                background: busy ? "var(--surface-inset)" : "var(--text-primary)",
                color: busy ? "var(--text-tertiary)" : "var(--surface-card)",
                cursor: busy ? "not-allowed" : "pointer",
              }}
            >
              {busy ? "verifying…" : "verify"}
            </button>
            <button
              type="button"
              onClick={() => {
                setStep("creds");
                setOtpCode("");
                setError(null);
              }}
              disabled={busy}
              className="text-[11px] uppercase tracking-[0.08em] font-semibold px-3 py-1.5 rounded-[8px] border"
              style={{ borderColor: "var(--hairline)", color: "var(--text-secondary)" }}
            >
              back
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
      )}
    </li>
  );
}
