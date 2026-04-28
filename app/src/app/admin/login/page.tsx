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
      // Cookie is set by the server; SWR caches don't know yet but the
      // target page will fetch /api/me on mount and pick up admin=true.
      router.push(redirectTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-dvh flex items-center justify-center bg-bg-primary p-6">
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
          className="bg-bg-secondary border border-border rounded-2xl p-4 space-y-3"
        >
          <label className="block">
            <span className="text-[13px] uppercase tracking-wide text-text-tertiary">
              Password
            </span>
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-[15px] focus:outline-none focus:border-text-primary"
              disabled={submitting}
            />
          </label>

          {error && (
            <p className="text-[13px] text-red-600 bg-red-50 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || password.length === 0}
            className="w-full rounded-xl bg-text-primary text-bg-primary text-[15px] font-medium py-2.5 disabled:opacity-50"
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
    <main className="min-h-dvh flex items-center justify-center bg-bg-primary p-6">
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
