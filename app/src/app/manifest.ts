// PWA manifest. Defines what happens when the user installs Helios as
// a standalone app (iOS "Add to Home Screen" / Android "Install app").
//
// Icon strategy:
//   - icon.svg     → tab favicon (modern browsers; SVG scales any size)
//   - icon.tsx     → 512×512 PNG with white bg (Android PWA install)
//   - apple-icon.tsx → 180×180 PNG with white bg (iOS home screen)
//
// theme_color is the install-time default for the standalone status-bar
// tint and the Android splash toolbar. We match the light page surface so
// the status bar dissolves into the app; at runtime the theme-color meta
// (managed in layout.tsx / lib/theme.ts) takes over and follows the live
// theme, including dark mode. The brand moment now lives on the splash
// (background_color + orange mark), not the status bar.
//
// background_color is the splash-screen background while the app boots —
// kept white so the orange mark contrasts cleanly during the brief flash
// before render.

import type { MetadataRoute } from "next";
import { PAGE_SURFACE } from "@/lib/themeColors";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Helios",
    short_name: "Helios",
    description: "Home energy intelligence — solar, Powerwall, EV.",
    start_url: "/",
    display: "standalone",
    background_color: "#FFFFFF",
    theme_color: PAGE_SURFACE.light,
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
      },
      {
        src: "/icon",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/apple-icon",
        sizes: "180x180",
        type: "image/png",
      },
    ],
  };
}
