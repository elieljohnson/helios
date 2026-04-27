// 512×512 PNG used as the PWA install icon on Android. Same white-bg
// composition as apple-icon.tsx, just at the size Android Chrome
// pulls when the user "Install app" / "Add to Home Screen"s the PWA.
//
// Coexists with src/app/icon.svg (the favicon). Browsers see both
// link rels in <head>; modern browsers prefer the SVG for the tab,
// while PWA installers grab the PNG referenced from manifest.ts.

import { ImageResponse } from "next/og";
import { HeliosMark } from "@/components/HeliosMark";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          background: "white",
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <HeliosMark size={460} />
      </div>
    ),
    size,
  );
}
