import { beforeEach, describe, expect, it, vi } from "vitest";
import { bustCache, cached } from "./cache";

describe("cached()", () => {
  beforeEach(() => {
    // Reset module state between tests — the cache is process-global
    // and tests share it otherwise.
    bustCache();
  });

  it("returns the value from fn on a miss", async () => {
    const fn = vi.fn().mockResolvedValue("hello");
    const result = await cached("k", 100, fn);
    expect(result).toBe("hello");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns the cached value within TTL without re-running fn", async () => {
    const fn = vi.fn().mockResolvedValue("hello");
    await cached("k", 1000, fn);
    await cached("k", 1000, fn);
    await cached("k", 1000, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("re-runs fn after TTL expires", async () => {
    const fn = vi.fn().mockResolvedValue("hello");
    await cached("k", 5, fn);
    await new Promise((r) => setTimeout(r, 15));
    await cached("k", 5, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent calls — only one fetch fires", async () => {
    // Without single-flight, two parallel cache misses would each
    // run fn() and one would overwrite the other's cache entry. We
    // want exactly one underlying fetch shared by all callers in the
    // same TTL window.
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return "value";
    });
    const results = await Promise.all([
      cached("k", 1000, fn),
      cached("k", 1000, fn),
      cached("k", 1000, fn),
    ]);
    expect(results).toEqual(["value", "value", "value"]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("bustCache(key) forces a refetch on the next call", async () => {
    const fn = vi.fn().mockResolvedValue("hello");
    await cached("k", 1000, fn);
    bustCache("k");
    await cached("k", 1000, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("bustCache() with no argument clears every key", async () => {
    const fn1 = vi.fn().mockResolvedValue("a");
    const fn2 = vi.fn().mockResolvedValue("b");
    await cached("k1", 1000, fn1);
    await cached("k2", 1000, fn2);
    bustCache();
    await cached("k1", 1000, fn1);
    await cached("k2", 1000, fn2);
    expect(fn1).toHaveBeenCalledTimes(2);
    expect(fn2).toHaveBeenCalledTimes(2);
  });

  it("keeps separate cache entries per key", async () => {
    const fn1 = vi.fn().mockResolvedValue("a");
    const fn2 = vi.fn().mockResolvedValue("b");
    const a = await cached("k1", 1000, fn1);
    const b = await cached("k2", 1000, fn2);
    expect(a).toBe("a");
    expect(b).toBe("b");
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it("propagates the fetch error and does not cache failures", async () => {
    // A thrown fn() should NOT poison the cache — next caller gets
    // another chance, otherwise a transient Tesla blip would lock
    // the dashboard out for the full TTL.
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("recovered");
    await expect(cached("k", 1000, fn)).rejects.toThrow("transient");
    const result = await cached("k", 1000, fn);
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
