// PWA manifest. Defines what happens when the user installs Helios as
// a standalone app (iOS "Add to Home Screen" / Android "Install app").
//
// Icon strategy:
//   - icon.svg     → tab favicon (modern browsers; SVG scales any size)
//   - icon.tsx     → 512×512 PNG with white bg (Android PWA install)
//   - apple-icon.tsx → 180×180 PNG with white bg (iOS home screen)
//
// theme_color drives the standalone status-bar tint and the splash
// screen on Android. We pick the brand orange so the launch feels
// branded; once the page loads, the actual UI takes over.
//
// background_color is the splash-screen background while the app
// boots — kept white so the orange mark contrasts cleanly during the
// brief flash before render.

import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Helios",
    short_name: "Helios",
    description: "Home energy intelligence — solar, Powerwall, EV.",
    start_url: "/",
    display: "standalone",
    background_color: "#FFFFFF",
    theme_color: "#DB7507",
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
