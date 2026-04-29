"use client";

import type { Cache } from "swr";

/**
 * localStorage-backed SWR cache provider.
 *
 * Why this exists: when the PWA cold-starts (the OS killed the
 * background process, the user re-opens from the home screen),
 * SWR's in-memory cache is empty and every page renders the
 * "loading…" state until the first network round-trip completes.
 * For our /api/status the round-trip is ~1-2s — long enough to
 * feel like a blank screen.
 *
 * With this provider, SWR reads its initial cache from localStorage
 * synchronously on mount. The dashboard renders the LAST KNOWN
 * STATE instantly, while SWR revalidates in the background. The
 * FreshnessIndicator's pulsing dot tells the user fresh data is
 * inbound, and the timestamp shows how stale the visible data is.
 *
 * Trade-offs:
 *   - Cache outlives schema changes. If the API response shape
 *     evolves, an old cache might render briefly until revalidation
 *     replaces it. We tolerate this — the alternative is showing
 *     "loading…" on every cold start which is worse.
 *   - localStorage is synchronous. Reading 30-50KB on mount is
 *     under 5ms in practice; not worth optimizing further.
 *   - SSR / Node has no localStorage. The provider returns a fresh
 *     Map there (effectively no-op) and the browser fills it in on
 *     the client side.
 *
 * Storage key versioning: bump CACHE_VERSION when the StatusResponse
 * shape changes in a way that would render badly. The mismatch path
 * silently discards the old cache.
 */

const CACHE_KEY = "helios-swr-cache";
const CACHE_VERSION = 1;

/** Endpoints whose responses should NEVER be persisted to localStorage.
 *  Auth state in particular: /api/me reflects whether the current
 *  cookie is valid. Persisting it would mean a stale {admin: false}
 *  from a logged-out session could render across a successful login,
 *  or vice versa. Always fetch live. */
const PERSIST_DENYLIST = new Set<string>(["/api/me"]);

type SerializedEntry = [string, unknown];
type SerializedCache = { v: number; entries: SerializedEntry[] };

export function localStorageProvider(): Cache {
  // SSR / build-time / no-window environments. SWR will create a
  // fresh in-memory cache and the client side will hydrate over it.
  if (typeof window === "undefined") return new Map();

  // Read on mount. Tolerate corrupt JSON, version skew, and
  // localStorage being unavailable (private browsing in some
  // browsers throws on access). Filter denylisted keys on read AND
  // write — both gates so a legacy persisted entry from before the
  // denylist existed still gets evicted.
  let initial: SerializedEntry[] = [];
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (raw) {
      const parsed: SerializedCache = JSON.parse(raw);
      if (parsed && parsed.v === CACHE_VERSION && Array.isArray(parsed.entries)) {
        initial = parsed.entries.filter(([k]) => !PERSIST_DENYLIST.has(k));
      }
    }
  } catch {
    // corrupt or unavailable — fall through with an empty cache
  }

  const map = new Map<string, unknown>(initial);

  // Write on tab close. `pagehide` fires reliably on iOS Safari
  // (where PWAs run) and on desktop browsers; `beforeunload` is a
  // belt-and-suspenders fallback for older Chrome.
  function persist() {
    try {
      const entries = Array.from(map.entries()).filter(
        ([k]) => !PERSIST_DENYLIST.has(k),
      );
      const payload: SerializedCache = {
        v: CACHE_VERSION,
        entries,
      };
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    } catch {
      // storage quota exceeded, private browsing, etc. — silent
    }
  }

  window.addEventListener("pagehide", persist);
  window.addEventListener("beforeunload", persist);
  // Also persist when the page becomes hidden (PWA backgrounded
  // without unloading). Belt-and-suspenders for iOS where the OS
  // can kill the process without firing pagehide first.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persist();
  });

  return map as Cache;
}
