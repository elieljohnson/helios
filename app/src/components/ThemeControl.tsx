"use client";

import { useTheme, type Theme } from "@/lib/theme";

const OPTIONS: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * Three-way appearance control (System / Light / Dark). Reuses the same
 * active-pill treatment as the TabBar — active segment fills with
 * --text-primary and its label inverts to --surface-card — so it reads
 * correctly in both themes without per-theme overrides.
 */
export function ThemeControl() {
  const { theme, setTheme } = useTheme();
  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className="inline-flex gap-1 p-1 rounded-full"
      style={{
        background: "var(--surface-inset)",
        border: "1px solid var(--hairline)",
      }}
    >
      {OPTIONS.map((o) => {
        const active = theme === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setTheme(o.value)}
            className="px-4 py-1.5 rounded-full text-[12px] font-medium uppercase tracking-[0.08em] transition-colors"
            style={{
              background: active ? "var(--text-primary)" : "transparent",
              color: active ? "var(--surface-card)" : "var(--text-secondary)",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
