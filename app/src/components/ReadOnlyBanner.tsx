// Subtle banner shown above Settings when the visitor is not signed in.
// Replaces the temptation to disable every input visually — instead the
// inputs stay interactive (so recruiters can feel the form responsiveness),
// but the Save buttons turn into a "Sign in to save" link and the master
// AutomationToggle is locked. Server-side proxy.ts is the actual gate.

import Link from "next/link";

export function ReadOnlyBanner() {
  return (
    <div
      className="mb-3 flex items-center gap-3 rounded-2xl border px-4 py-3"
      style={{
        background: "var(--surface-inset)",
        borderColor: "var(--hairline)",
      }}
    >
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold text-text-primary">
          Read-only demo
        </div>
        <div className="text-[12px] text-text-secondary mt-0.5 leading-relaxed">
          You&apos;re viewing the live state of Eliel&apos;s home system.
          Settings are locked for visitors.
        </div>
      </div>
      <Link
        href="/admin/login?redirect=/settings"
        className="shrink-0 text-[13px] font-medium px-3 py-1.5 rounded-lg border"
        style={{
          background: "var(--surface-card)",
          borderColor: "var(--hairline)",
          color: "var(--text-primary)",
        }}
      >
        Sign in
      </Link>
    </div>
  );
}
