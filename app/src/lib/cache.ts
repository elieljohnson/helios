// Tiny module-scoped TTL cache with single-flight.
//
// Lives on a single Vercel function instance (~5–15 min lifetime
// typical, reset on cold start). Two consumers today: `/api/status`
// and `/api/recommendation`, both caching their `assembleStatus()`
// result for 10s to absorb burst polls without lying about freshness.
//
// TTL choice rationale — do NOT change without reading docs/case-study
// or thinking through the UX implications. Summary:
//
//   - 10s is at the human perception threshold for "live" energy data.
//     During state transitions (engine fires, Tesla CT desync, etc.)
//     the dashboard catches up within one blink.
//   - 30s tested feel: source-health badge can lie for long enough to
//     be perceived as gaslighting during a real provider outage. Not
//     shipped for that reason.
//   - 10s on a steady 30s poll cadence saves only burst traffic (page
//     load, multi-device overlap, interactive clicks-around). That's
//     fine — those bursts are exactly the unpredictable, expensive
//     traffic; steady polls are predictable and 1× the cost regardless.
//
// CORRECTNESS depends on every state-mutating route calling
// bustCache() after a successful write. Without that, the next read
// shows stale data for up to TTL — a "did it save?" UX failure.
// Today only `/api/config` POST needs busting because it's the only
// mutation that changes fields embedded in the status snapshot
// (specifically nem_export_rate flows through to CostCard). Reserve
// writes, action-log writes, auth changes, push subs, WC ingest, etc.
// do NOT need busting because they don't affect assembleStatus output.

type CacheEntry<T> = { value: T; expiresAt: number };

const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * Return a cached value if fresh, otherwise call `fn()` and cache the
 * result for `ttlMs` milliseconds. Concurrent calls with the same key
 * share one in-flight fetch (single-flight) so two simultaneous polls
 * never duplicate the underlying work.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;

  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = (async () => {
    try {
      const value = await fn();
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  return promise;
}

/**
 * Invalidate a specific cache key, or all keys when called with no
 * argument. Call from mutating route handlers AFTER a successful
 * write so the next read fetches fresh state.
 *
 * Does NOT cancel any in-flight fetch for the same key. A fetch that
 * started before bustCache() will still write its (now-stale) result
 * into the cache on completion. The race window is narrow (one TTL
 * worst case) and the alternative — cancellation logic on top of
 * single-flight — is far more complex than the marginal correctness
 * gain. Document, don't engineer around.
 */
export function bustCache(key?: string): void {
  if (key === undefined) {
    cache.clear();
    return;
  }
  cache.delete(key);
}
