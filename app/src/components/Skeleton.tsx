// Skeleton primitive — a single shimmering rectangle. Used by
// DashboardSkeleton.tsx and any other page that needs a placeholder
// for content that hasn't arrived yet.
//
// Sized via inline style or className override. Default style is the
// `helios-skeleton` shimmer animation defined in globals.css; the
// `prefers-reduced-motion` media query in the same place auto-disables
// the sweep for users who've opted out.

import type { CSSProperties } from "react";

export type SkeletonProps = {
  /** Pixel width. Defaults to "100%" when omitted. */
  width?: number | string;
  /** Pixel height. Defaults to 14 (one line of body text). */
  height?: number | string;
  /** Override border-radius. Useful for circular avatars / dots. */
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
};

export function Skeleton({
  width,
  height = 14,
  radius,
  className,
  style,
}: SkeletonProps) {
  return (
    <span
      className={`helios-skeleton inline-block ${className ?? ""}`}
      style={{
        width: width ?? "100%",
        height,
        borderRadius: radius,
        ...style,
      }}
      aria-hidden="true"
    />
  );
}
