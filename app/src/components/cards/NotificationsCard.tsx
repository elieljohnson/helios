"use client";

// Settings card for the Web Push subscribe flow under Option B.
//
// State machine:
//   - "loading"       — first render, before getPushStatus() resolves
//   - "unsupported"   — browser lacks SW or PushManager (e.g. iOS
//                       Safari tab — must install the PWA to home screen)
//   - "denied"        — user previously declined Notification permission;
//                       browser-level reset is required (user has to go
//                       into iOS Settings → Helios → Notifications)
//   - "off"           — supported, not subscribed; subscribe button shown
//   - "on"            — subscribed; unsubscribe button shown
//   - "busy"          — request in flight (during subscribe/unsubscribe)
//   - "error: <msg>"  — last action failed; transitions back to a real
//                       state on the next button press
//
// The card stays interactive even for read-only visitors — push
// subscription is per-device and doesn't mutate shared system state,
// so there's no admin gate. The user agreeing to notifications gives
// them push for THEIR phone only.

import { useEffect, useState } from "react";

import {
  getPushStatus,
  subscribeToPush,
  unsubscribeFromPush,
  type PushStatus,
} from "@/lib/push-client";

type ViewState =
  | { kind: "loading" }
  | { kind: "unsupported" }
  | { kind: "denied" }
  | { kind: "off" }
  | { kind: "on" }
  | { kind: "busy"; from: "off" | "on" }
  | { kind: "error"; message: string; previous: PushStatus["kind"] };

type TestState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; delivered: number; attempted: number }
  | { kind: "fail"; message: string };

function pushStatusToView(s: PushStatus): ViewState {
  switch (s.kind) {
    case "unsupported":
      return { kind: "unsupported" };
    case "denied":
      return { kind: "denied" };
    case "subscribed":
      return { kind: "on" };
    case "not-subscribed":
      return { kind: "off" };
  }
}

export function NotificationsCard() {
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [test, setTest] = useState<TestState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    getPushStatus().then((s) => {
      if (!cancelled) setView(pushStatusToView(s));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSendTest() {
    setTest({ kind: "busy" });
    try {
      const res = await fetch("/api/admin/test-push", { method: "POST" });
      if (!res.ok) {
        if (res.status === 401) {
          setTest({
            kind: "fail",
            message: "Admin login required. Sign in via /api/admin/login first.",
          });
          return;
        }
        setTest({ kind: "fail", message: `HTTP ${res.status}` });
        return;
      }
      const body = (await res.json()) as { delivered?: number; attempted?: number };
      setTest({
        kind: "ok",
        delivered: body.delivered ?? 0,
        attempted: body.attempted ?? 0,
      });
    } catch (err) {
      setTest({
        kind: "fail",
        message: err instanceof Error ? err.message : "send failed",
      });
    }
  }

  async function onSubscribe() {
    setView({ kind: "busy", from: "off" });
    try {
      await subscribeToPush();
      setView({ kind: "on" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "subscribe failed";
      setView({ kind: "error", message, previous: "not-subscribed" });
    }
  }

  async function onUnsubscribe() {
    setView({ kind: "busy", from: "on" });
    try {
      await unsubscribeFromPush();
      setView({ kind: "off" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unsubscribe failed";
      setView({ kind: "error", message, previous: "subscribed" });
    }
  }

  return (
    <section className="h-card">
      <div className="h-card-head">
        <span className="label">
          Notifications
        </span>
      </div>
      <p className="text-[13px] text-text-secondary leading-relaxed mb-3">
        Helios pings your phone when it recommends a charging change.
        One tap on the notification opens the Rivian app.
      </p>
      <Body view={view} onSubscribe={onSubscribe} onUnsubscribe={onUnsubscribe} />
      {view.kind === "on" ? (
        <TestPushRow test={test} onSend={onSendTest} />
      ) : null}
    </section>
  );
}

function TestPushRow({
  test,
  onSend,
}: {
  test: TestState;
  onSend: () => void;
}) {
  return (
    <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--hairline)" }}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-text-tertiary mono">
          {test.kind === "idle" && "Verify the round-trip"}
          {test.kind === "busy" && "sending…"}
          {test.kind === "ok" &&
            `Delivered ${test.delivered}/${test.attempted}. Check the lock screen.`}
          {test.kind === "fail" && `Failed: ${test.message}`}
        </span>
        <button
          type="button"
          disabled={test.kind === "busy"}
          onClick={onSend}
          className="shrink-0 text-[13px] font-medium px-3 py-1.5 rounded-lg border disabled:opacity-50"
          style={{
            background: "var(--surface-card)",
            borderColor: "var(--hairline)",
            color: "var(--text-primary)",
          }}
        >
          Send test push
        </button>
      </div>
    </div>
  );
}

function Body({
  view,
  onSubscribe,
  onUnsubscribe,
}: {
  view: ViewState;
  onSubscribe: () => void;
  onUnsubscribe: () => void;
}) {
  switch (view.kind) {
    case "loading":
      return <span className="text-text-tertiary text-[13px] mono">loading…</span>;
    case "unsupported":
      return (
        <Hint>
          Push notifications need the Helios app installed to your phone&apos;s
          home screen. On iPhone: open Helios in Safari, tap Share →
          &ldquo;Add to Home Screen&rdquo;, then open the home-screen icon and
          come back to this page.
        </Hint>
      );
    case "denied":
      return (
        <Hint>
          Notifications are blocked at the browser level. Re-enable them in
          your phone&apos;s Settings → Helios → Notifications, then refresh.
        </Hint>
      );
    case "off":
      return (
        <Action
          state="Off"
          buttonLabel="Enable notifications"
          onClick={onSubscribe}
        />
      );
    case "on":
      return (
        <Action
          state="On — this device"
          buttonLabel="Disable"
          buttonVariant="ghost"
          onClick={onUnsubscribe}
        />
      );
    case "busy":
      return (
        <Action
          state={view.from === "off" ? "Off" : "On — this device"}
          buttonLabel="…"
          disabled
          onClick={() => {}}
        />
      );
    case "error":
      return (
        <div>
          <Hint danger>Couldn&apos;t complete: {view.message}</Hint>
          <button
            type="button"
            className="mt-2 text-[13px] font-medium px-3 py-1.5 rounded-lg border"
            style={{
              background: "var(--surface-card)",
              borderColor: "var(--hairline)",
              color: "var(--text-primary)",
            }}
            onClick={view.previous === "subscribed" ? onUnsubscribe : onSubscribe}
          >
            Try again
          </button>
        </div>
      );
  }
}

function Action({
  state,
  buttonLabel,
  buttonVariant = "primary",
  disabled,
  onClick,
}: {
  state: string;
  buttonLabel: string;
  buttonVariant?: "primary" | "ghost";
  disabled?: boolean;
  onClick: () => void;
}) {
  const isPrimary = buttonVariant === "primary";
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[13px] text-text-tertiary mono">{state}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className="shrink-0 text-[13px] font-medium px-3 py-1.5 rounded-lg border disabled:opacity-50"
        style={{
          background: isPrimary
            ? "var(--accent-warm, #DB7507)"
            : "var(--surface-card)",
          borderColor: isPrimary
            ? "var(--accent-warm, #DB7507)"
            : "var(--hairline)",
          color: isPrimary ? "white" : "var(--text-primary)",
        }}
      >
        {buttonLabel}
      </button>
    </div>
  );
}

function Hint({
  children,
  danger,
}: {
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <p
      className="text-[12px] leading-relaxed"
      style={{ color: danger ? "var(--alert)" : "var(--text-tertiary)" }}
    >
      {children}
    </p>
  );
}
