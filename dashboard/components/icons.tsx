// Minimal inline SVG icon set for the Overview redesign — 24px viewBox,
// 1.5 stroke, currentColor, Heroicons/Lucide-style outlines. No icon library
// dependency; every icon used on the page lives here so StatTile / EmptyState
// / ErrorState / the dialog / the header stay consistent.

export type IconProps = React.SVGProps<SVGSVGElement>;

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function IconGlobe(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M3.75 12h16.5M12 3.75c2.2 2.3 3.3 5.2 3.3 8.25s-1.1 5.95-3.3 8.25c-2.2-2.3-3.3-5.2-3.3-8.25S9.8 6.05 12 3.75z" />
    </svg>
  );
}

export function IconLayers(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M12 3.75l8.25 4.5L12 12.75l-8.25-4.5L12 3.75z" />
      <path d="M3.75 12.75L12 17.25l8.25-4.5" />
      <path d="M3.75 16.5L12 21l8.25-4.5" />
    </svg>
  );
}

export function IconBuildingStorefront(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M3.75 9.75l1.1-4.5a1.5 1.5 0 011.46-1.13h11.38a1.5 1.5 0 011.46 1.13l1.1 4.5" />
      <path d="M3.75 9.75a2.25 2.25 0 004.5.2 2.25 2.25 0 004.5 0 2.25 2.25 0 004.5 0 2.25 2.25 0 004.5-.2" />
      <path d="M5.25 10.5V19.5a.75.75 0 00.75.75h4.5V16.5h3v3.75h4.5a.75.75 0 00.75-.75V10.5" />
    </svg>
  );
}

export function IconUsers(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <circle cx="8.5" cy="8" r="3" />
      <path d="M2.75 19a5.75 5.75 0 0111.5 0" />
      <path d="M14.75 5.3a3 3 0 010 5.4" />
      <path d="M16.25 13.25a5.75 5.75 0 015 5.75" />
    </svg>
  );
}

export function IconPhone(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M4.5 4.5h3.4l1.35 4.05-2.1 1.7a11.25 11.25 0 005.6 5.6l1.7-2.1L18.5 15v3.4a1.5 1.5 0 01-1.6 1.5A15.75 15.75 0 013 4.6a1.5 1.5 0 011.5-.1z" />
    </svg>
  );
}

export function IconShoppingCart(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M2.75 3.75h2l2.1 10.6a1.5 1.5 0 001.47 1.2h7.36a1.5 1.5 0 001.47-1.17l1.4-6.63H5.5" />
      <circle cx="9" cy="20" r="1.15" />
      <circle cx="17" cy="20" r="1.15" />
    </svg>
  );
}

export function IconMail(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <rect x="3" y="5.25" width="18" height="13.5" rx="1.5" />
      <path d="M3.5 6.5L12 13l8.5-6.5" />
    </svg>
  );
}

export function IconStar(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M12 3.5l2.47 5.15 5.53.63-4.13 3.86 1.1 5.61L12 15.9l-4.97 2.85 1.1-5.61-4.13-3.86 5.53-.63L12 3.5z" />
    </svg>
  );
}

export function IconMapPin(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M12 21.5s7-6.4 7-12A7 7 0 105 9.5c0 5.6 7 12 7 12z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </svg>
  );
}

export function IconAlertTriangle(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M10.65 4.1a1.5 1.5 0 012.7 0l8.1 14.55a1.5 1.5 0 01-1.35 2.2H3.9a1.5 1.5 0 01-1.35-2.2l8.1-14.55z" />
      <path d="M12 9.5v4.25" />
      <circle cx="12" cy="17" r="0.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M12 4.5v15M4.5 12h15" />
    </svg>
  );
}

export function IconCheckCircle(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M8.5 12.4l2.4 2.4 4.6-5.3" />
    </svg>
  );
}

// Queued-ingest state (a job waiting for the Mac-mini poller to claim it) —
// see docs/superpowers/specs/2026-07-03-ingest-queue-poller-design.md.
export function IconClock(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 7.5v4.8l3 1.8" />
    </svg>
  );
}

// Collapse/expand toggle for CitiesTable's country/region group rows —
// rotate 90deg (▸ -> ▾) via a `rotate-90` class on the caller side rather
// than a separate "down" variant, so there's one icon to keep in sync.
export function IconChevronRight(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M9 5.25l6 6.75-6 6.75" />
    </svg>
  );
}

// Statistics date-range picker (components/statistics/DateRangePicker.tsx):
// the trigger's calendar glyph, its caret, and the calendar's month arrows.
// IconChevronRight above is the same shape as IconChevronLeft mirrored, but
// both are spelled out — a CSS-rotated one loses its meaning to a screen
// reader's rendering of the surrounding label and to anyone reading the JSX.
export function IconCalendar(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <rect x="3.25" y="5" width="17.5" height="15.75" rx="2.5" />
      <path d="M3.25 9.5h17.5M8 3.25v3.5M16 3.25v3.5" />
    </svg>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M5.25 9l6.75 6 6.75-6" />
    </svg>
  );
}

export function IconChevronLeft(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M15 5.25l-6 6.75 6 6.75" />
    </svg>
  );
}

// Jobs panel header button (bell) — see docs/superpowers/specs/
// 2026-07-02-background-jobs-design.md "Header jobs indicator".
export function IconBell(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M6 8.25a6 6 0 1112 0c0 4.55 1.13 6.1 1.5 6.5H4.5c.37-.4 1.5-1.95 1.5-6.5z" />
      <path d="M10.35 18.75a1.65 1.65 0 003.3 0" />
    </svg>
  );
}

// Loop/refresh glyph used as the "running" status icon in the jobs panel —
// caller applies `animate-spin`. A proper double-arrow loop rather than the
// plain "↻" text glyph the older RerunToast/RowActions used, to match the
// "inline SVG, matching the existing icon style" instruction for new icons.
export function IconSpinner(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M4.5 12a7.5 7.5 0 0112.99-5.15" />
      <path d="M19.5 12a7.5 7.5 0 01-12.99 5.15" />
      <path d="M17.5 6.85h2.6v-2.6" />
      <path d="M6.5 17.15H3.9v2.6" />
    </svg>
  );
}

export function IconXCircle(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
    </svg>
  );
}

// City page: opens a florist's website in a new tab, next to their name in
// the table and in the map popup (docs/superpowers/specs/
// 2026-07-02-city-page-redesign-brief.md "optional" feature).
export function IconExternalLink(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M14.25 4.5h5.25v5.25" />
      <path d="M19.5 4.5L10.5 13.5" />
      <path d="M18 13.5V18a1.5 1.5 0 01-1.5 1.5H6A1.5 1.5 0 014.5 18V7.5A1.5 1.5 0 016 6h4.5" />
    </svg>
  );
}

// ---- Staff shell nav icons (unified redesign — Foundation milestone) ----
// components/shell/StaffShell.tsx sidebar. Same 24px/1.5-stroke outline style
// as the set above; reuses IconBuildingStorefront (Florists), IconClock
// (Jobs) and IconGlobe rather than duplicating near-identical glyphs.

export function IconHome(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M3.75 11.25L12 4.5l8.25 6.75" />
      <path d="M5.5 9.75V19a.75.75 0 00.75.75h4.5v-5.25h2.5v5.25h4.5a.75.75 0 00.75-.75V9.75" />
    </svg>
  );
}

// Orders — a receipt/list glyph, distinct from IconShoppingCart (used
// elsewhere for the "ecommerce" florist signal) so the two aren't confused.
export function IconReceipt(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M6 3.75h12v16.5l-2.25-1.5-2.25 1.5-2.25-1.5-2.25 1.5-2.25-1.5-2.25 1.5V3.75z" />
      <path d="M8.5 8.25h7M8.5 11.5h7M8.5 14.75h4.5" />
    </svg>
  );
}

export function IconChatBubble(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M3.75 6.75A2.25 2.25 0 016 4.5h12a2.25 2.25 0 012.25 2.25v7.5A2.25 2.25 0 0118 16.5H9l-4.5 3.75v-3.75h-.75a2.25 2.25 0 01-2.25-2.25v-7.5z" />
      <path d="M8 9.75h8M8 12.75h5" />
    </svg>
  );
}

export function IconCreditCard(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <rect x="3" y="5.25" width="18" height="13.5" rx="1.75" />
      <path d="M3 9.75h18" />
      <path d="M6.5 14.25h3.5" />
    </svg>
  );
}

// Discovery — a compass, distinct from IconGlobe (used for the "Countries"
// stat tile on the Discovery page itself).
export function IconCompass(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M14.75 9.25l-1.4 4.1-4.1 1.4 1.4-4.1 4.1-1.4z" />
    </svg>
  );
}

export function IconShieldCheck(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M12 3.5l7 2.75v5.4c0 4.4-3 7.3-7 9-4-1.7-7-4.6-7-9V6.25L12 3.5z" />
      <path d="M8.75 12.2l2.25 2.25 4.25-4.7" />
    </svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <circle cx="12" cy="12" r="2.75" />
      <path d="M12 3.75v2.1M12 18.15v2.1M20.25 12h-2.1M5.85 12h-2.1M17.6 6.4l-1.5 1.5M7.9 16.1l-1.5 1.5M17.6 17.6l-1.5-1.5M7.9 7.9L6.4 6.4" />
    </svg>
  );
}

export function IconMenu(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M4 6.5h16M4 12h16M4 17.5h16" />
    </svg>
  );
}

export function IconFlow(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <rect x="4" y="4" width="6" height="4.5" rx="1" />
      <rect x="14" y="9.75" width="6" height="4.5" rx="1" />
      <rect x="4" y="15.5" width="6" height="4.5" rx="1" />
      <path d="M10 6.25h2.25a1.5 1.5 0 011.5 1.5v2.25M10 17.75h2.25a1.5 1.5 0 001.5-1.5v-2" />
    </svg>
  );
}

export function IconActivity(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M3 12h4l2.5-7 5 14 2.5-7H21" />
    </svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <circle cx="10.75" cy="10.75" r="6.25" />
      <path d="M19.25 19.25l-4.3-4.3" />
    </svg>
  );
}

export function IconChartBar(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M4 20V10M10 20V4M16 20v-7M20 20H4" />
    </svg>
  );
}

// Operator panel (/operator) — a checklist with a tick. Distinct from
// IconReceipt (Orders, the full reference list) on purpose: the two sit next to
// each other in the sidebar, so at 18px they have to be told apart by shape.
export function IconClipboardCheck(props: IconProps) {
  return (
    <svg {...base} aria-hidden="true" {...props}>
      <path d="M9 4.75h6M9.75 3.25h4.5a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-.75.75h-4.5A.75.75 0 0 1 9 5.5V4a.75.75 0 0 1 .75-.75z" />
      <path d="M15.75 4.75h1.5a1.5 1.5 0 0 1 1.5 1.5v12.5a1.5 1.5 0 0 1-1.5 1.5H6.75a1.5 1.5 0 0 1-1.5-1.5V6.25a1.5 1.5 0 0 1 1.5-1.5h1.5" />
      <path d="M9.25 13.1l1.9 1.9 3.6-4.2" />
    </svg>
  );
}
