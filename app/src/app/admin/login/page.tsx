// Admin sign-in page. Single-input password form.
//
// On success, redirects to ?redirect=<path> if provided (Settings link
// passes ?redirect=/settings), otherwise back to the home page.
//
// Note on the Suspense wrapper: Next.js requires useSearchParams() to
// be inside a Suspense boundary so static prerendering can bail out
// to client-side rendering for the dynamic param read. Without the
// wrapper the production build fails with a "missing-suspense" error.

"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { mutate as globalMutate } from "swr";
import { HeliosMark } from "@/components/HeliosMark";

export default function AdminLoginPage() {
  return (
    <Suspense fallback={<LoginShell />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirectTo = params.get("redirect") || "/";
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error || "Sign in failed");
        setSubmitting(false);
        return;
      }
      // Invalidate the /api/me SWR cache so the destination page
      // re-fetches and sees admin=true. Without this, router.push() does
      // a soft navigation that reuses the cached {admin:false} response
      // — Settings would render in read-only mode despite the cookie
      // being set.
      await globalMutate("/api/me");
      // Also invalidate caches that the server may now return
      // un-redacted (status, integrations, config).
      await globalMutate("/api/status");
      await globalMutate("/api/integrations");
      await globalMutate("/api/config");
      router.push(redirectTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  }

  return (
    <main
      className="min-h-dvh flex items-center justify-center p-6"
      style={{ background: "var(--surface-deep)" }}
    >
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <HeliosMark size={56} />
          <h1 className="mt-3 text-[22px] font-semibold text-text-primary">
            Helios admin
          </h1>
          <p className="text-[14px] text-text-secondary mt-1">
            Sign in to edit settings.
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="rounded-2xl p-4 space-y-3 border"
          style={{
            background: "var(--surface-card)",
            borderColor: "var(--hairline)",
          }}
        >
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">
              Password
            </span>
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              className="mt-1 w-full rounded-xl px-3 py-2 text-[15px] focus:outline-none border mono"
              style={{
                background: "var(--surface-card)",
                borderColor: "var(--hairline)",
                color: "var(--text-primary)",
              }}
            />
          </label>

          {error && (
            <p
              className="text-[13px] rounded-lg px-3 py-2"
              style={{
                color: "var(--alert)",
                background: "var(--alert-soft)",
              }}
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || password.length === 0}
            className="w-full rounded-xl text-[15px] font-medium py-2.5 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: "var(--text-primary)",
              color: "var(--surface-card)",
            }}
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="text-[12px] text-text-tertiary mt-4 text-center">
          Read-only dashboard is at{" "}
          <a href="/" className="underline">
            /
          </a>
          .
        </p>
      </div>
    </main>
  );
}

// Static fallback rendered while Next.js hydrates the form on the
// client. Same chrome as the live form so the page doesn't visibly
// reflow when the search params resolve.
function LoginShell() {
  return (
    <main
      className="min-h-dvh flex items-center justify-center p-6"
      style={{ background: "var(--surface-deep)" }}
    >
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <HeliosMark size={56} />
          <h1 className="mt-3 text-[22px] font-semibold text-text-primary">
            Helios admin
          </h1>
          <p className="text-[14px] text-text-secondary mt-1">Loading…</p>
        </div>
      </div>
    </main>
  );
}
