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
    // /api/me is cheap and the answer rarely changes mid-session, so
    // skip the periodic revalidation that the dashboard's other
    // endpoints use.
    revalidateOnFocus: false,
    revalidateIfStale: false,
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
