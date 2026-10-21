// Which face the app shows. One codebase serves Facundo (staging, v2 — real
// florists) and the client-facing "Smart design" demo (the garden deployment).
// Only the look changes: name, logo, colours, font and the staff menu. Every
// route and behaviour is the same under both.
//
// Build-time (`NEXT_PUBLIC_BRAND`) rather than a runtime var so client
// components (StaffShell, FloristShell) read it without prop threading. Set
// only in .github/workflows/deploy-garden.yml; unset means Facundo.
//
// Pure + dependency-free so it runs under `node --test`.

export type BrandId = "facundo" | "smart-design";

export function parseBrand(value: string | undefined): BrandId {
  return value === "smart-design" ? "smart-design" : "facundo";
}

export const BRAND: BrandId = parseBrand(process.env.NEXT_PUBLIC_BRAND);

export const BRAND_NAME: Record<BrandId, string> = {
  facundo: "Facundo",
  "smart-design": "Smart design",
};

// The six staff screens' own headings, renamed to match the Smart design menu
// (StaffShell). Any other title passes through unchanged.
const SMART_DESIGN_TITLES: Record<string, string> = {
  "Control panel": "Today",
  Orders: "Deliveries",
  Conversations: "Inbox",
  Payments: "Payouts",
  Florists: "Partners",
  "Statistics & Insights": "Reports",
};

export function titleFor(brand: BrandId, title: string): string {
  return brand === "smart-design" ? (SMART_DESIGN_TITLES[title] ?? title) : title;
}

export function pageTitle(title: string): string {
  return titleFor(BRAND, title);
}
