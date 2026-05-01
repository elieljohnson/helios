// Browser-side helpers for the Web Push subscribe flow. Used by the
// Settings notifications card (B6).
//
// Flow:
//   1. ensureServiceWorker() — register /sw.js if not already.
//   2. subscribeToPush()     — fetch VAPID public key, call
//                              pushManager.subscribe(), POST to
//                              /api/push/subscribe.
//   3. unsubscribeFromPush() — local unsubscribe + POST /api/push/unsubscribe.
//
// All functions throw on failure; the UI catches and renders an error
// state. Designed for "click button to enable / click again to
// disable" — no internal state, just primitives.

"use client";

const SW_PATH = "/sw.js";

export type PushStatus =
  | { kind: "unsupported" }
  | { kind: "denied" }
  | { kind: "subscribed"; endpoint: string }
  | { kind: "not-subscribed" };

/** Detect feature support. iOS Safari requires the PWA to be installed
 *  to home screen for Notification + serviceWorker.pushManager — this
 *  check returns "unsupported" in a regular Safari tab. */
function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Probe current subscription state without prompting the user. */
export async function getPushStatus(): Promise<PushStatus> {
  if (!pushSupported()) return { kind: "unsupported" };
  if (Notification.permission === "denied") return { kind: "denied" };
  const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
  if (!reg) return { kind: "not-subscribed" };
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return { kind: "not-subscribed" };
  return { kind: "subscribed", endpoint: sub.endpoint };
}

async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration(SW_PATH);
  if (existing) return existing;
  return navigator.serviceWorker.register(SW_PATH, { scope: "/" });
}

/** Standard helper: VAPID keys are base64url-encoded; pushManager
 *  needs them as a Uint8Array. */
function urlBase64ToUint8Array(b64: string): Uint8Array {
  const padding = "=".repeat((4 - (b64.length % 4)) % 4);
  const base64 = (b64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** Full subscribe path: prompts for permission, registers SW, calls
 *  pushManager.subscribe, persists to /api/push/subscribe. Throws on
 *  any failure step. */
export async function subscribeToPush(): Promise<{ endpoint: string }> {
  if (!pushSupported()) {
    throw new Error("Push notifications not supported in this browser.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(`Permission ${permission}.`);
  }

  const reg = await ensureServiceWorker();

  const keyRes = await fetch("/api/push/vapid-public-key");
  if (!keyRes.ok) throw new Error("VAPID public key unavailable.");
  const { vapidPublicKey } = (await keyRes.json()) as { vapidPublicKey: string };

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    // `Uint8Array<ArrayBufferLike>` (TS 5.7+) doesn't structurally
    // satisfy BufferSource here; the underlying value is the same.
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
  });

  // PushSubscription.toJSON() emits the canonical { endpoint, keys }
  // shape the server expects.
  const json = sub.toJSON() as {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };

  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...json, userAgent: navigator.userAgent }),
  });
  if (!res.ok) {
    // Roll back local subscription so the next attempt is clean.
    try {
      await sub.unsubscribe();
    } catch {
      /* noop */
    }
    throw new Error(`Subscribe failed: ${res.status}`);
  }

  return { endpoint: json.endpoint };
}

/** Reverse of subscribeToPush. Tolerates "wasn't subscribed" — just
 *  no-ops. */
export async function unsubscribeFromPush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration(SW_PATH);
  if (!reg) return;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;

  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  await fetch("/api/push/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}
