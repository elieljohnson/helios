import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import Script from "next/script";
import { Providers } from "@/components/Providers";
import { PAGE_SURFACE } from "@/lib/themeColors";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Helios",
  description: "Home energy intelligence — solar, battery, EV, and grid in one calm surface.",
  // Installed iOS PWA chrome. statusBarStyle is read at launch and can't
  // switch live, so we pick "default" (a light bar, right for the light /
  // system default); a manually-forced dark theme on an installed iPhone
  // PWA won't re-tint it. Android + in-browser iOS follow the theme-color
  // meta dynamically (see themeScript below).
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Helios",
  },
};

// Runs before hydration: reads the saved preference (falling back to the
// OS setting), sets .theme-dark on <html> so dark-mode visitors never see
// a white flash, and tints the status bar (theme-color meta) to match the
// resolved surface from the very first paint. Delivered via next/script
// `beforeInteractive`, which Next injects into the document itself rather
// than through React's render tree — the raw-<script>-in-JSX form trips a
// React 19 "scripts inside React components are never executed on the
// client" warning. Must stay in sync with the class name / storage key in
// lib/theme.ts and the colors in lib/themeColors.ts.
const themeScript = `(function(){try{var k='helios-theme',s=localStorage.getItem(k),d=s==='dark'||((s==='system'||!s)&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('theme-dark');var m=document.querySelector('meta[name="theme-color"]');if(!m){m=document.createElement('meta');m.setAttribute('name','theme-color');document.head.appendChild(m);}m.setAttribute('content',d?'${PAGE_SURFACE.dark}':'${PAGE_SURFACE.light}');}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning: the theme script mutates the <html>
    // className before hydration, which would otherwise trip a
    // server/client mismatch warning on this element.
    <html
      lang="en"
      className={`${inter.variable} ${jetbrains.variable}`}
      suppressHydrationWarning
    >
      <body>
        <Script
          id="helios-theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: themeScript }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
