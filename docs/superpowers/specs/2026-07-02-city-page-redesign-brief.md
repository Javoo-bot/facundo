# City page (`/city/[id]`) redesign — design brief

Date: 2026-07-02. Redesigns the visual/interaction layer of the per-city detail page,
consistent with the shipped overview redesign (`2026-07-02-overview-redesign-brief.md`).
Scoring math (`lib/scoring.ts`), spread (`lib/spread.ts`), and data contract unchanged.

## Current-code defects to fix (found in audit — real, not cosmetic)
1. `FloristTable` has NO real sorting (no click/state/aria-sort) — build it (mirror
   `CitiesTable`'s SortableTh/caret; default Score desc).
2. Table row selection isn't keyboard-accessible (add tabIndex/onKeyDown/focus ring).
3. `ScoreBreakdown` is a full-screen dimmed modal that blocks the map/table — make it a
   non-blocking side drawer (desktop) so the analyst can keep clicking rows/pins.
4. Ecommerce mark uses emerald ✓ / red ✗ — must be **indigo** (targeting attribute,
   never pass/fail). Website ✗ = slate (absence ≠ failure), not red.
5. Map hover ring `#2563eb` (blue) is off-palette → emerald-600.
6. `app/city/[id]/page.tsx` swallows Supabase errors (outage renders as "not found") —
   capture errors, show a distinct error state.
7. Page bg inherits `bg-slate-100`; overview uses `bg-slate-50` — fix the mismatch.
8. Numeric cells not `tabular-nums` — add everywhere (rating/reviews/distance/score).
9. Re-run still uses the old sidebar inline-log pattern → migrate to `RerunToast`.
10. Slider min/max bounds unlabeled → add endpoint labels.
11. Email/phone are plain text → `mailto:`/`tel:` links (it's an outreach tool).

## Layout — viewport-locked workbench (not page-scroll)
Because sliders live-re-rank every frame, keep the whole page filling the viewport with
NO page scroll; only the table body scrolls internally.
```
<div class="flex h-screen flex-col bg-slate-50">
  <header h-14: ← Overview | h1 = "{city}, {country}" (identity only) | How it works · ↻ Re-run · UserMenu>
  <main flex-1 overflow-hidden px-6 py-4>
    meta row: "{radius} km radius" · region pill · "Last ingested {date}"  (city.ingested_at — new)
    <CityVitalsBar/>  (single compact strip reusing overview encodings)
    <grid lg:[300px_1fr]>
      <ControlsRail/>  (collapsible 300px↔48px; badge of #non-default sliders when collapsed)
      <col> <MapCard h-[320-360px] + MapLegend> <TableCard flex-1 internal-scroll> </col>
    </grid>
  </main>
  <FloristDetailPanel/>  (fixed right drawer, non-modal on desktop)
</div>
```

## Components
Reuse verbatim: `RatingChip`, `CoverageMeter`, `EcommercePill`, `CountPill`, `RerunToast`,
`UserMenu`, `HowDataCollectedModal`, `icons`, `lib/bands`, `lib/stats.computeCityStats`,
`lib/scoring`, `lib/spread`.

Generalize (add props, don't duplicate): `EmptyState` (icon/title/description/cta),
`ErrorState` (title/description).

New: `app/city/[id]/loading.tsx` (skeleton), `CityVitalsBar` (compact strip: florists,
avg-rating chip, top-targets pill, %ecommerce pill, %reachable meter, drafts pill — from
`computeCityStats(initialFlorists)`, i.e. the RAW dataset so it doesn't flicker while
sliders move; live filtered count shown as a small "Showing X of N" caption + Reset link),
`ControlsRail` (collapse chrome around SliderPanel), `MapLegend` (floating card: 4 rating
bands + spread-ring + center-star), a per-florist `BoolBadge`/website+ecommerce badge
(indigo ecommerce, slate false, `?` unknown — NOT the city-level EcommercePill).

Modified: `page.tsx` (capture query errors), `DashboardClient` (layout restructure),
`Map` (hover ring → emerald, mount MapLegend, restyle popup with RatingChip + bool badges
+ mail/phone icons), `SliderPanel` (min/max labels; per-weight contribution mini-bars —
emerald positive / red negative, computed via `scoreBreakdown()` against the selected
florist or rank #1; section label "Weights — effect on {name}"), `FloristTable` (real
sorting, keyboard row selection, tabular-nums, RatingChip, bool badges, mailto/tel links),
`ScoreBreakdown` (non-modal drawer on ≥1024px / modal fallback below; internal score-bar +
draft-email logic unchanged; aria-live announce on content swap).

## States
- Loading: skeleton `loading.tsx`.
- City not found: keep (restyle, add map-pin icon, bg-slate-50).
- Fetch error (new): distinct ErrorState when either Supabase query errors.
- Empty — zero florists ingested: replace map+table with EmptyState + "↻ Re-run" CTA.
- Empty — filters exclude all: map shows center star only; table shows "0 of N match your
  filters" + Reset button.
- Re-run in progress: header ↻ disables+spins → RerunToast; router.refresh on success.

## Responsive
≥1280 full (rail expanded); 1024–1279 rail collapsed + narrower drawer; 768–1023 switch to
page-scroll, controls become a full-width disclosure (2-col sections), map fixed 300px,
table x-scroll, detail = modal; <768 functional fallback only (map behind a toggle, table
primary) — not polished, flag for QA.

## A11y / type / motion
`h1` = city name only; table `<caption class=sr-only>` + `<th scope=col>` + aria-sort;
rows focusable + Enter/Space; icon-only controls get aria-label; detail panel non-modal
`role=region aria-label` + aria-live on desktop, modal below; map noted as
table-is-the-accessible-source (sr-only note). Reuse overview type scale; `tabular-nums`
on all numbers; micro-interactions 100–200ms, `prefers-reduced-motion` guarded; add a
`panel-slide-in` keyframe (consider renaming the `animate-overview-*` keyframes to
page-agnostic names — non-blocking).

## Decisions taken (designer recommendations, adopt unless changed)
- Vitals reflect the RAW dataset (stable), filtered count in a separate caption.
- Weight contribution bars target the selected florist, else rank #1 (ambient, not a CTA).
- Slider state still resets on reload (localStorage persistence = future, out of scope).
- <768px = functional fallback only.
- Optional (not in core scope): an external-link icon by a florist name to open their site
  directly from the table (needs one new icon).

## Sequencing
Implement AFTER feature #1's frontend lands (both touch the dashboard heavily) — avoid
concurrent edits to the same components.
