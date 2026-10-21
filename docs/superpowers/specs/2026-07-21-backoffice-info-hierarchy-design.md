# Backoffice information-hierarchy redesign

**Date:** 2026-07-21
**Status:** approved (mockup signed off)
**Mockup:** `.claude/jobs/03fc2cd8/tmp/backoffice-redesign-mockup.html` (5 screens, live timers)

## Goal

Bring the important details to the front across the staff backoffice, and make status
legible at a glance everywhere. The backoffice is already feature-rich (KPI home,
`StageStepper`, `cxAttention` urgency model, per-surface row coloring) — this is an
**information-hierarchy pass**, not a rebuild. The unifying move is a single shared
color/priority layer that every surface consumes, plus targeted layout changes on the
two detail pages so the most-used data uses the space wisely.

## Locked decisions (from the user)

- **Hybrid color scheme.** Attention states (red = critical/breaching, amber =
  waiting/at-risk) always override; otherwise a **muted stage hue** shows pipeline
  position (created=slate, matched=indigo, outreach=violet, fulfilment=teal,
  delivery=blue, delivered=green). Red/amber are reserved for attention — never a stage.
- **Scope:** all of it, one plan — keystone + Home + Orders + Order detail + Florists
  list + Florist detail.
- **Florists list defaults to `production`** (the lifecycle stage the matcher treats as
  order-eligible); pipeline florists hidden by default.
- **Order detail + Florist detail** are re-laid-out to lead with the most important data
  and use horizontal space (command bar + vitals strip; header band + stat tiles).

## The keystone — `dashboard/lib/orderVisual.ts` (new, pure, unit-tested)

One source of truth for status → color and order → priority, consumed by every table,
badge, and row across the app. Pure module (no React/IO), import-free enough to unit-test
under node type-stripping (mirror the repo pattern: `cxAlertRules.ts`, `orderStages.ts`).

Builds on what exists — does **not** duplicate it:
- reuses `lib/orderStages.ts::stageOf` for the stage hue,
- reuses `lib/cxAttention.ts` urgency semantics for the attention predicate/priority
  (extract the shared shape if needed rather than re-deriving thresholds).

Exports:

- `type OrderTone = "crit" | "warn" | "created" | "matched" | "outreach" | "fulfilment" | "delivery" | "delivered" | "done"`
- `orderTone(order): OrderTone` — **hybrid**: if attention → `crit`/`warn`; else the
  stage hue; `closed`/`cancelled` → `done` (grey).
- `orderPriority(order): 0 | 1 | 2 | 3` — 0 = requires attention, 1 = awaiting
  acceptance (`reaching_out`,`matched`), 2 = in progress (`accepted`,`in_production`,
  `ready`,`out_for_delivery`), 3 = done (`delivered`†,`paid`,`closed`,`cancelled`).
- `requiresAttention(order): { attn: boolean; severity: "crit"|"warn"|null; reason?: string }`
  — the single predicate: `escalated`; all offers expired/declined (no accepting
  florist); past delivery deadline and not delivered; `delivered` with an **open money
  hold** (photo verdict `review` / held 30% leg); match failed (zero candidates).
- `orderSortKey(order)` — `[priority, deliveryDeadlineAsc, urgency]` for the default sort.
- CSS-class helpers `toneRowClass(tone)` / `toneBadgeClass(tone)` mapping to
  design-system classes (see below).

† **"delivered with open money" stays visible.** The Orders "hide completed" default
hides `delivered`-*and-clean* + `paid`/`closed`/`cancelled`, but keeps a delivered order
whose payout is still held for review (it's attention, priority 0).

## Design-system tokens — `dashboard/app/design-system.css`

Add the muted stage-hue tokens + row/badge classes so coloring is declarative and
theme-aware (light + dark), reusing the existing `.row-sev-*` inset-left-border mechanic:

- tokens `--st-created/-matched/-outreach/-fulfilment/-delivery/-delivered` (light + dark).
- row classes `.row-tone-{crit,warn,created,…,done}` (left stripe; crit/warn also tint).
- badge classes `.badge-{created,matched,outreach,fulfilment,delivery,delivered}`.

Existing `--accent/--crit/--warn/--bloom` and `.badge-*` are unchanged; `badgeMap.ts`
`ORDER_CLS` is re-pointed to go through `orderTone` so one status→visual map wins.

## Surface changes

### 1. Orders list — `components/orders/OrdersClient.tsx`
- Default filter **hides completed** (priority 3) except attention-held; a chip toggles
  "show all".
- Default sort = `orderSortKey` (priority → deadline), replacing `delivery_at asc`.
- Row coloring via `toneRowClass(orderTone(order))` — full hybrid, superseding the
  SLA-only `rowSevClass`. Keep the attention banner + attention filter (already present).
- `orderStatusBadge` → `toneBadgeClass`.

### 2. Home — `components/home/HomeClient.tsx`
- KPI tiles regrouped/relabeled: **Orders today · Awaiting acceptance · In progress ·
  Delivered today · Requires attention (crit)**. (Drop/merge the current 7 into these 5.)
- Replace the attention *count-links* with an **inline attention table** (the top-N
  `requiresAttention` orders, each row = order · reason · recipient·area · florist ·
  deliver · total), reusing the same tone row classes and linking to the order.

### 3. Order detail — `components/orders/OrderDetailClient.tsx`
- **Command bar**: order id + status badge + `StageStepper` (compact, inline) + the
  single primary stage action + "Change stage ▾" — one row, replacing the stacked
  header + full-width stepper + separate action bar.
- **Vitals strip** (horizontal, 6 cells, tabular): florist (+tier +distance) ·
  deliver-to (country/city + address) · delivery date/window · recipient · **two live
  timers** (count-up since `created_at`; count-down to `delivery_at`, amber < 1h, red
  when overdue). New `components/orders/OrderTimers.tsx` (client, `setInterval`,
  `prefers-reduced-motion` aware, cleans up on unmount).
- **Balanced 2-column** reference grid of collapsible cards (`<details>`): Now-panel +
  Line items lead; Order&buyer / Payment&payout / Delivery-proof / Timeline collapsed.
- **Data the strip needs:** join `cities(city, country)` via `order.city_id` in the
  server page fetch; compute **distance** live (haversine, florist lat/lng ↔
  `delivery_lat/lng`) in a pure `lib/geo.ts::haversineKm` — null-guarded, falls back to
  `delivery_area` text and hides distance when no florist is assigned. Add the fetch in
  `app/(staff)/orders/[id]/page.tsx`.

### 4. Florists list — `components/florists/FloristsDirectory.tsx`
- Server fetch adds per-florist **active** + **pending** order counts (aggregate over
  `order_assignments`: active = accepted/in-production/ready legs; pending = candidate/
  sent/opened offers). Add to `app/(staff)/florists/page.tsx`.
- Columns reordered to operational load: **Country · City · Florist · Tier · Active ·
  Pending · History · Payments**. Default sort country → city → active desc.
- **Default filter `lifecycle_stage = "production"`** with a chip to widen to the full
  pipeline. Row tone via the shared helper.

### 5. Florist detail — `components/florist/FloristCardClient.tsx`
- **Compact header band**: name · 🇪🇸 city/country · trust tier · Production · capacity ·
  contact · Message/Exclude — replacing the tall header card.
- **Stat-tile row (6)**: Active orders · Pending offers · On-time% · Acceptance% ·
  Rating · Owed now. (Quality trio confirmed with user if they track different signals.)
- **Two-column body:** primary = Current orders table + Payouts (operational reality);
  secondary = Operational/Activity/Notes/Meetings/Outreach as collapsibles. CRM no longer
  outranks live work.

### 6. Consistency sweep
Re-point the remaining status-colored tables (CX `CxAttention`, Payments, External ops,
florist assignment tables) at `orderTone`/`toneBadgeClass` so the hybrid scheme is
uniform. No behavior change — visual only.

## Order-loop map

Per CLAUDE.md, update `dashboard/lib/lifecycle.ts` in the same PR: the redesign surfaces
the delivered-with-held-money and no-accepting-florist branches more prominently — reflect
any status/branch that becomes "handled" by the new attention surfacing.

## Non-goals

No new order operations or state machine changes (the stage-control/rematch/assign work
is a separate, already-shipped concern). No schema changes — counts/joins are read-side.
No new auth surfaces. Visual/IA only.

## Verification

- **Keystone:** unit tests for `orderTone` (attention overrides stage; done→grey),
  `orderPriority`, `requiresAttention` (each trigger + the delivered-with-hold case),
  `orderSortKey`, `haversineKm` (null guards). `npm test` green, `tsc` clean.
- **Browser (chrome-devtools-mcp):** exercise all five surfaces signed-in; confirm
  attention rows read red/amber and calm rows carry the right stage hue in **both
  themes**; Orders default-hides completed and sorts by priority; the two order timers
  tick and the countdown flips amber→red; Florists defaults to Production and the
  active/pending counts are correct; Florist detail leads with stat tiles.
- End with a `code-reviewer` pass (null-guards on distance/counts, the delivered-with-hold
  predicate, theme parity, no data leak when signed out).
