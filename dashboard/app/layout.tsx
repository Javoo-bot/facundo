import type { Metadata } from "next";
import { IBM_Plex_Sans, Inter } from "next/font/google";
import "./globals.css";
import "./design-system.css";
import { BRAND, BRAND_NAME } from "@/lib/brand";

/* One typeface for the whole product. Before this the app had no webfont at
   all: `--sans` was the OS stack, so the same screen was SF Pro on a Mac,
   Segoe on Windows and Roboto on Android — and it only applied inside `.ds`,
   leaving staff pages outside that scope on Tailwind's own default stack.
   `next/font` downloads Inter at build time and serves it from our own origin,
   so there is no runtime request to Google and no flash of fallback text.

   The variable is consumed in two places, which together cover every page:
   `theme.fontFamily.sans` in tailwind.config.ts (Tailwind's preflight puts
   that on <html>) and `--sans` in design-system.css (the `.ds` scope). */
const inter = Inter({
  // latin-ext for the Portuguese/Polish-range glyphs the six locales in
  // lib/i18n/messages can produce; plain `latin` already covers es/fr/de.
  subsets: ["latin", "latin-ext"],
  display: "swap",
  variable: "--font-sans",
});

// The Smart design brand's face (lib/brand.ts). Same `--font-sans` variable,
// so Tailwind and `--sans` pick it up with no other change.
const plex = IBM_Plex_Sans({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: BRAND === "facundo" ? "Facundo Florist Discovery" : BRAND_NAME[BRAND],
  description: "Internal POC dashboard for florist discovery and scoring.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-brand={BRAND} className={BRAND === "facundo" ? inter.variable : plex.variable}>
      <body>{children}</body>
    </html>
  );
}
