// 180×180 PNG generated at build time. iOS uses this as the home-screen
// icon when the user "Add to Home Screen"s the PWA. iOS does NOT respect
// SVG transparency for home-screen icons, so we bake the white background
// into the raster output here. The orange Helios mark is centered with
// ~22% padding on each side (Apple's recommended safe zone).

import { ImageResponse } from "next/og";
import { HeliosMark } from "@/components/HeliosMark";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
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
        <HeliosMark size={120} />
      </div>
    ),
    size,
  );
}
