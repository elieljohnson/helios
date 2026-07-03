/**
 * Page-surface colors per resolved theme, used for the browser / PWA
 * status-bar tint (the <meta name="theme-color"> content).
 *
 * These MUST track `--surface-deep` in globals.css — they are the color
 * the status bar dissolves into at the top of the app. Kept here, in a
 * plain (non-"use client") module, so all three consumers share one
 * source: the theme provider (runtime meta updates), the root layout
 * (first-paint init script), and the PWA manifest.
 */
export const PAGE_SURFACE = {
  light: "#E6E6E6",
  dark: "#171719",
} as const;
