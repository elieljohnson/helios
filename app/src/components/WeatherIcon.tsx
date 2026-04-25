import type { WeatherIcon as IconName } from "@/lib/types";

// Inline SVG glyphs matching the prototype's Lucide-style icons.
export function WeatherIcon({ name, size = 20 }: { name: IconName; size?: number }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (name) {
    case "sun":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      );
    case "cloud-sun":
      return (
        <svg {...p}>
          <path d="M12 2v2M5.64 5.64l1.41 1.41M2 12h2M20 12h2M19.07 5.64l-1.41 1.41" />
          <circle cx="9" cy="9" r="3" />
          <path d="M17 17a4 4 0 0 0 0-8h-.8A6 6 0 0 0 9 13a5 5 0 0 0 8 4Z" />
        </svg>
      );
    case "cloud":
      return (
        <svg {...p}>
          <path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8 6 6 0 0 0-11.6 2.1A4.5 4.5 0 0 0 6 19h11.5Z" />
        </svg>
      );
    case "rain":
      return (
        <svg {...p}>
          <path d="M16 14v4M12 16v4M8 14v4" />
          <path d="M17 10a4 4 0 1 1 1 7.9H6a5 5 0 1 1 .9-9.9A6 6 0 0 1 17 10Z" />
        </svg>
      );
  }
}
