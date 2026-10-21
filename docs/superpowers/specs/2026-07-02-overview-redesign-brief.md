# Overview page redesign — UI/UX design brief

Date: 2026-07-02. Redesigns the VISUAL/INTERACTION layer of the `/` Overview+Hub
(feature #2). IA + data contract (`lib/stats.ts`) unchanged. Desktop-first internal
tool: clarity + scannability first, modern and considered. No new deps — plain
Tailwind v3 (stock config), inline SVG for icons, in-house accessible modal.

## Fixed conventions to reuse (do NOT reinvent)
- Neutral scale: `slate` (bg-slate-50 page, slate-200 borders, slate-400/500 muted,
  slate-700/900 text). Primary/brand: `emerald` (600 rest / 700 hover). Negative:
  `red`. These stay.
- **Canonical 4-band rating scale (from `Map.tsx`, use verbatim):** ≥4.5 green-500,
  ≥4.3 lime-500, ≥4.0 amber-500, <4.0 red-500, null slate-400. The map pins on
  `/city/[id]` and the rating chips here must mean the same thing.
- Existing modal pattern (`HowDataCollectedModal`/`ScoreBreakdown`): `fixed inset-0
  z-[1100] bg-black/40`, centered `rounded-lg bg-white shadow-xl`, backdrop onClick
  close + panel stopPropagation, `×` top-right, disabled-while-running.
- Streaming ingest UI (`useIngestStream`, `AddCityForm`, `RerunCityButton`): dark
  `bg-slate-900` monospace log box, disabled inputs while running, Cancel. Reused.

## Color system (adds amber + indigo, both in default Tailwind)
- **Contrast formula, applied to every chip/pill:** `{hue}-700` text on `{hue}-50`
  bg, optional `ring-1 ring-inset ring-{hue}-600/20`. Clears WCAG AA.
- Rating chip / Top-targets: rating-band hues (green/lime/amber/red) — top targets
  are rating≥4.5 so they use green.
- Coverage (% reachable): good/med/poor → emerald ≥70% / amber 40–69% / red <40% /
  slate no-data.
- Ecommerce (% ecommerce): its own hue `indigo` (targeting attribute, NOT pass/fail)
  — intensity bands: indigo-600 solid ≥60%, indigo-100/700 30–59%, indigo-50/500
  1–29%, slate 0/null.
- Drafts ready: emerald pill (ties to FloristTable's ✉ convention).
- Outreach placeholders (sent/replies/reply-rate): slate-200 dashed border, slate-300
  "—", `title="Not tracked yet — coming with CRM integration"`.
- **Never color-alone:** every colored cell also shows a number/symbol.

## Layout
- **Sticky app header** `sticky top-0 z-40 bg-white border-b h-14`: title left; right
  = **"+ Add city"** primary button (the one dialog trigger, persistent on scroll) →
  `UserMenu`. `flex flex-wrap` for narrow; button collapses to icon+aria-label <400px.
- Global summary strip (restyled stat tiles), `px-6 py-6`.
- Cities section: `<h2>` "Cities" + right-aligned "N cities · M countries", then the
  table (or empty/error state).
- Remove the old inline "Add a city" section from the page body.
- Container widened to `max-w-[1440px] mx-auto px-6`.

## Cities table (centerpiece)
Columns L→R: **City** (name+link, radius subtext) · **Florists** (plain tabular num) ·
**Avg rating** (rating chip; subtext "N reviews") · **Top targets** (green pill) ·
**% Ecommerce** (indigo intensity pill) · **% Reachable** (coverage meter bar) ·
**Emails found** (plain num) · **Drafts ready** (emerald pill) · **Sent / Replies /
Reply rate** (grouped header "Outreach performance" + SOON badge; dashed placeholder
cells) · **Actions** (↻ Re-run icon-btn, View → link). Total reviews = subtext under
rating chip, not its own column.

Two-row `<thead>`: row 1 group labels via colSpan (MARKET cols 2–4, TARGETING 5–6,
OUTREACH READINESS 7–8, OUTREACH PERFORMANCE + SOON badge 9–11); row 2 `<th
scope="col">` headers, `bg-slate-50 text-xs font-semibold uppercase tracking-wide
text-slate-500`. Sortable headers are `<button>` with `aria-sort`, caret ▲/▼
(opacity-0 group-hover when inactive, emerald-600 when active). Header row sticky
`top-14 z-20`.

Grouping = real rows in the same column grid (rollups land in same cells/encodings):
- Country row: `<th scope="rowgroup">` `bg-slate-100 border-l-4 border-l-emerald-700
  font-semibold text-slate-900` + bold rollup cells, blank Actions.
- Region row: `bg-slate-50 border-l-4 border-l-slate-300 text-slate-600 font-medium`,
  indented (`↳`/pl-8). "Other" region → italic slate-500.
- City leaf row: `bg-white border-b border-slate-100 py-3`, hover
  `hover:bg-emerald-50/60 transition-colors`. No zebra.

Cell encodings (exact):
- Rating chip: `rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset
  ring-{band}-600/20 bg-{band}-50 text-{band}-700` → "★ 4.6"; subtext `text-[11px]
  text-slate-400` "128 reviews".
- Top targets: `rounded-md bg-green-50 text-green-700 px-1.5 py-0.5 text-xs
  font-semibold tabular-nums`.
- % Ecommerce: rounded-full pill, indigo intensity bands above.
- % Reachable meter: `h-1.5 w-16 rounded-full bg-slate-100` track + `bg-{band}-500`
  fill (width %) + `text-xs tabular-nums text-{band}-700` label + `title="{n} of
  {total} reachable"`.
- Emails found: plain `text-sm text-slate-600 tabular-nums` (neutral count).
- Drafts ready: `rounded-md bg-emerald-50 text-emerald-700 px-1.5 py-0.5 text-xs
  font-semibold tabular-nums`.
- Placeholder: `border border-dashed border-slate-200 text-slate-300 "—"` + title.
- Governing rule: plain numerals for neutral counts; colored pills for outcome/quality
  counts; meters for coverage %; intensity pills for targeting %.

Row actions (right, `w-32`, always visible): ↻ Re-run = icon ghost btn
(`aria-label`, hover emerald), one-click (auto-fetch keywords + stream like today);
in-flight → glyph `animate-spin`, disabled, City cell tinted, progress streams into a
bottom-right **RerunToast** (not inline row expand). View → = emerald link to
`/city/[id]`, arrow nudges on hover.

Sorting: single-column toggle asc/desc/none, **scoped within each region group**
(never breaks hierarchy).

## Global summary tiles
Grid `grid-cols-2 sm:grid-cols-4 lg:grid-cols-8`. Each tile: `rounded-lg border
border-slate-200 bg-white p-4 shadow-sm border-b-2 border-b-{accent}` + 28px icon chip
(`bg-{accent}-50 text-{accent}-600`, inline SVG) + `text-2xl font-bold tabular-nums`
value + `text-xs font-semibold uppercase tracking-wide text-slate-500` label. Accents:
Countries/Regions/Cities → emerald; Florists → slate; Reachable → dynamic coverage
band; Ecommerce → indigo; Drafts → emerald; Avg rating → dynamic rating band (keep ★
glyph). Icons: minimal inline SVG (24px, 1.5 stroke, currentColor, Heroicons/Lucide
style) — NOT emoji.

## Add-city dialog
Trigger: header "+ Add city" primary button. Shell reuses HowDataCollectedModal
pattern: `fixed inset-0 z-[1100] bg-black/40 flex items-center justify-center p-4`,
panel `w-full max-w-lg max-h-[85vh] overflow-y-auto rounded-xl bg-white p-6
shadow-2xl`. Backdrop + Escape close **disabled while ingest running** (must Cancel
first). Content = today's AddCityForm fields (Country onBlur→keyword fetch; keyword
chips restyled `bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 rounded-full`
with × remove; language badge; City; Radius + Limit side by side; Ingest/Cancel; dark
streaming log box `aria-live="polite"`). On success: replace body with success panel
(green check + "Boston, US added." + [Done] → close + `router.refresh()`). A11y:
`role="dialog" aria-modal="true" aria-labelledby`, focus Country on open, focus trap,
background `inert` while open.

## States
- Empty (0 cities): tiles show real zeros (Avg rating "—"); table replaced by centered
  dashed card (48px slate-300 map-pin SVG, "No cities yet", subtext, a duplicate large
  +Add city CTA).
- Loading: new `app/loading.tsx` skeleton matching layout (pulsing tiles + skeleton
  table), not a spinner.
- **Error (Supabase fetch fails) — also a real bug fix:** `app/page.tsx` currently
  discards the query `error` and `?? []`, so an outage looks identical to "0 cities".
  Capture `error` from both queries; on non-null render a distinct ErrorState (red-600
  icon, "Couldn't load cities", [Retry] = router.refresh()).
- Re-run in progress: row tint + spin + bottom-right RerunToast (`fixed bottom-4
  right-4 w-96 z-50 rounded-lg border bg-white shadow-xl`, dark log box + Cancel;
  success → green check + auto-dismiss ~3s + refresh; error → red, manual close).

## Responsive
- ≥1024px: full table (`overflow-x-auto` safety, sane per-col min-w).
- 768–1023px: hide the 3 outreach-placeholder columns.
- <768px: switch to card layout (restyle the existing `CityCard` with the new chips/
  meters/pills) via `hidden md:block` (table) / `md:hidden` (cards); grouping still
  applies.
- Summary tiles grid unchanged.

## Typography / spacing
Reuse existing scale: title `text-lg font-semibold`; section headers `text-sm
font-semibold uppercase tracking-wide text-slate-500`; table headers `text-xs ...`;
cells `text-sm`; stat numbers `text-2xl font-bold`. `tabular-nums` on ALL numeric
cells/tiles.

## Accessibility
`<caption class="sr-only">` on the table; `<th scope="col">` leaf headers, `<th
scope="rowgroup">` group labels; `aria-sort` in sync; icon-only controls get
`aria-label`; dialog focus-trap + `aria-live` log + background `inert`; every colored
cell also carries a number/symbol; contrast via the {hue}-700/{hue}-50 formula.

## Micro-interactions (subtle, 100–200ms, respect prefers-reduced-motion)
Row hover bg-emerald-50/60; sort-header caret fade + text darken; primary btn
`active:scale-[0.98]`; dialog open = backdrop fade + panel fade/scale-95→100 (small
keyframe in globals.css); ↻ `animate-spin`; toast slide+fade + 3s success auto-dismiss;
View→ arrow nudge. Coverage meters: native `title` tooltip (no fill animation
required).

## New components to build
`AddCityDialog` (modal shell + AddCityForm logic + success sub-state; replaces the
inline expand), `CitiesTable` (owns sort state), `RatingChip` / `CoverageMeter` /
`EcommercePill` / `CountPill` (cell encodings), `RerunToast` (bottom-right, wraps log
box), `StatTile` (restyled with accent + icon), `EmptyState`, `ErrorState`,
`app/loading.tsx` skeleton, ~6–8 inline SVG icons. Reuse `lib/stats.ts` unchanged,
`useIngestStream`, `UserMenu`, `RerunCityButton` logic.

## Scope
Redesign the `/` overview only. `/city/[id]` unchanged (except the shared RatingChip
is reusable there later). Also fix the `page.tsx` error-swallowing bug (drives which
empty-vs-error state renders).
