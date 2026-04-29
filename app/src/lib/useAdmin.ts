// Client-side admin session hook. Wraps GET /api/me and exposes
// { admin, loading, signOut }.
//
// Used by Settings + AppShell to render read-only demo mode for
// unauthenticated visitors. The check is "best-effort" UI gating —
// the actual security gate is server-side in proxy.ts. If a recruiter
// hand-crafts a curl POST against /api/config, they'll still hit a 401.

"use client";

import useSWR, { mutate as globalMutate } from "swr";

type MeResponse = { admin: boolean; dev?: boolean };

const fetcher = (url: string) =>
  fetch(url).then((r) => r.json() as Promise<MeResponse>);

export function useAdmin() {
  const { data, isLoading, mutate } = useSWR<MeResponse>("/api/me", fetcher, {
    // Auth state must always be re-checked. Earlier versions of this
    // hook set revalidateIfStale: false on the assumption SWR's cache
    // was in-memory (always fresh on cold start). Once we added
    // localStorage persistence, that meant a stale {admin: false}
    // from a previous session would render forever — server-side
    // login would succeed but the UI would never notice the cookie
    // was now valid. Force revalidation on every mount and tab focus;
    // /api/me is ~50ms so the extra request cost is immaterial.
    revalidateOnFocus: true,
    revalidateIfStale: true,
    revalidateOnMount: true,
  });

  async function signOut() {
    await fetch("/api/admin/logout", { method: "POST" });
    await mutate();
    // Force any cached config/integrations data to refetch as a non-admin
    // (the server may now redact fields).
    await globalMutate("/api/config");
    await globalMutate("/api/integrations");
    await globalMutate("/api/status");
  }

  return {
    admin: data?.admin ?? false,
    loading: isLoading,
    /** True when ADMIN_TOKEN env var is unset on the server (dev). */
    dev: data?.dev ?? false,
    signOut,
  };
}
