"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { FreshnessIndicator } from "@/components/FreshnessIndicator";
import { HeliosMark } from "@/components/HeliosMark";

type Props = {
  children: ReactNode;
  location?: string;
  utility?: string;
  /** Optional freshness props. When provided, the header shows an
   *  "Updated Xs ago" indicator on the right, with a pulsing dot
   *  while SWR is revalidating. Pages that don't pass them simply
   *  don't show the indicator (Settings page, etc., where the user
   *  is editing rather than monitoring). */
  freshness?: {
    timestamp: string | undefined;
    isValidating: boolean;
  };
};

export function AppShell({ children, location, utility, freshness }: Props) {
  return (
    <main className="min-h-screen" style={{ background: "var(--surface-deep)" }}>
      <div className="max-w-[1200px] mx-auto px-4 md:px-8 pt-6 md:pt-10 pb-24">
        <Header location={location} utility={utility} freshness={freshness} />
        <div className="mt-6">{children}</div>
      </div>
      <TabBar />
    </main>
  );
}

function Header({
  location,
  utility,
  freshness,
}: {
  location?: string;
  utility?: string;
  freshness?: Props["freshness"];
}) {
  return (
    <div className="flex items-center flex-wrap gap-x-3 gap-y-1 px-2 whitespace-nowrap">
      <div className="flex items-center gap-2">
        <HeliosMark size={28} />
        <span className="font-semibold text-[18px]">Helios</span>
      </div>
      {location && (
        <>
          <span className="text-text-tertiary">·</span>
          <span className="text-[11px] uppercase tracking-[0.12em] text-text-secondary font-medium">
            {location}
          </span>
        </>
      )}
      {utility && (
        <>
          <span className="text-text-tertiary">·</span>
          <span className="text-[11px] uppercase tracking-[0.12em] text-text-secondary font-medium">
            {utility}
          </span>
        </>
      )}
      {freshness && (
        <span className="ml-auto">
          <FreshnessIndicator
            timestamp={freshness.timestamp}
            isValidating={freshness.isValidating}
          />
        </span>
      )}
    </div>
  );
}

function TabBar() {
  const pathname = usePathname();
  const tabs = [
    { href: "/", label: "Home" },
    { href: "/activity", label: "Activity" },
    { href: "/settings", label: "Settings" },
  ];
  return (
    <nav
      className="fixed bottom-4 left-1/2 -translate-x-1/2 flex gap-1 p-1 rounded-full border"
      style={{
        background: "var(--surface-card)",
        borderColor: "var(--hairline)",
        boxShadow: "0 0 0 0.5px var(--hairline)",
      }}
    >
      {tabs.map((t) => {
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            className="px-4 py-1.5 rounded-full text-[12px] font-medium uppercase tracking-[0.08em] transition-colors"
            style={{
              background: active ? "var(--text-primary)" : "transparent",
              color: active ? "var(--surface-card)" : "var(--text-secondary)",
            }}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
