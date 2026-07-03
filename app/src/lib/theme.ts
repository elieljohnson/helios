"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { PAGE_SURFACE } from "./themeColors";

/**
 * Theme system — three-state preference with a live "system" mode.
 *
 *   "system"  follow the OS (prefers-color-scheme), updating live
 *   "light"   force light
 *   "dark"    force dark
 *
 * The concrete theme is applied by toggling the `.theme-dark` class on
 * <html>, which flips the CSS custom properties defined in globals.css.
 *
 * FIRST-PAINT NOTE: this provider does NOT prevent the flash-of-wrong-
 * theme on load. That job belongs to the inline script in layout.tsx,
 * which runs before paint. The provider owns React state, keeps the DOM
 * class in sync on change, and — while on "system" — follows live OS
 * changes. It intentionally initializes to "system" on both server and
 * first client render (then hydrates from storage in an effect) so the
 * rendered control markup matches and React doesn't warn on hydration.
 */

export type Theme = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "helios-theme";

const DARK_CLASS = "theme-dark";

function systemPrefersDark(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/** Resolve a stored preference to the concrete theme to paint. */
export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === "system") return systemPrefersDark() ? "dark" : "light";
  return theme;
}

function applyResolved(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle(DARK_CLASS, resolved === "dark");

  // Keep the status-bar tint (theme-color meta) matching the app surface
  // so the bar dissolves into the top of the page. The head init script
  // creates this meta pre-paint; here we just keep its content current on
  // every theme change (incl. manual override and live OS switches).
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", PAGE_SURFACE[resolved]);
}

function readStored(): Theme {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(THEME_STORAGE_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : "system";
}

type ThemeContextValue = {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (t: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light");

  // Hydrate from storage after mount. The class was already applied
  // pre-paint by the head script; this only syncs React state so the
  // Settings control reflects the real preference.
  useEffect(() => {
    const stored = readStored();
    setThemeState(stored);
    setResolvedTheme(resolveTheme(stored));
  }, []);

  // Re-apply on preference change, and while on "system" track live OS
  // changes (e.g. the phone flips to dark at sunset with Helios open).
  useEffect(() => {
    const resolved = resolveTheme(theme);
    setResolvedTheme(resolved);
    applyResolved(resolved);

    if (theme !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const r: ResolvedTheme = mq.matches ? "dark" : "light";
      setResolvedTheme(r);
      applyResolved(r);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    }
    // Apply immediately so the flip is instant on click; the effect
    // above will also run but this avoids a one-frame lag.
    applyResolved(resolveTheme(next));
  }, []);

  return createElement(
    ThemeContext.Provider,
    { value: { theme, resolvedTheme, setTheme } },
    children,
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
