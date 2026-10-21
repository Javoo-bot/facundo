# Overview + Hub home page (feature #2)

Date: 2026-07-02
Builds on the existing dashboard. This is design cycle #2 of two (the other is
the outreach CRM, #3, a separate spec).

## Purpose

A new home screen that is BOTH an executive coverage/marketing overview AND a hub
(launchpad) — cities grouped country → region, with outreach-oriented statistics,
and the add-city / re-run / drill-in actions.

## Information architecture (restructure)

- **`/` → Overview + Hub** (auth-gated, RLS unchanged).
- The current per-city dashboard (map, sliders, table, score breakdown, city
  selector) **moves to `/city/[id]`** (`id` = the city UUID). The `CitySelector`
  is no longer needed on that page (you arrive with a city); keep a "← Overview"
  link back home.
- Sign-in / allow-list / `UserMenu` behavior unchanged; both routes are gated.

## Region derivation (free, from Nominatim)

- Add nullable `cities.region text` (migration + `schema.sql`).
- `geocode.py` already calls Nominatim; capture the administrative region from the
  response address (`state` / `province` / `region`, whichever is present) and
  store it. No extra Claude call. `region` is null when Nominatim doesn't provide
  one — the UI groups those under an "Other / —" region.
- `db.get_or_create_city` persists `region`; `main.py` passes it through.
- Existing city rows backfill on their next re-run; also provide a one-time
  `ingest/backfill_regions.py` that geocodes existing cities and sets `region`.

## Statistics (outreach/marketing lens)

Computed by pure functions in `dashboard/lib/stats.ts` (per-city + rollups),
unit-tested like `scoring.ts`.

**Per city:**
- Florists (count), avg rating, total reviews (demand proxy).
- # top targets (rating ≥ 4.5), % ecommerce (online-capable partners).
- % reachable (has email OR phone), # emails found, # drafts ready to send.
- Outreach performance placeholders — emails sent / replies / reply rate — render
  as "—" until CRM (#3) exists; `stats.ts` returns them as `null` for now.

**Region & country rollups:** the same metrics aggregated over their cities.

**Global summary strip (top of page):** countries, regions, cities, total
florists, total reachable, total ecommerce, # drafts ready, overall avg rating.

## Layout

- Global summary strip (cards / stat row) at the top.
- Below: **Country** sections → **Region** subsections → **City cards** grid.
  Each city card shows the per-city stats and links to `/city/[id]`; each card has
  a "↻ Re-run" control. Country/region headers show their rollups.
- "+ Add city" form lives on this page (moved from the city sidebar), reusing the
  existing `AddCityForm` + `useIngestStream`; on success it refreshes and the new
  city appears in its country/region group.

## Data flow

- `app/page.tsx` (server) fetches all `cities` + `florists` (RLS-gated), passes to
  a client `OverviewClient` that computes stats via `lib/stats.ts` and renders the
  grouped hub. POC scale (a few hundred florists) → client-side aggregation is
  fine. A Postgres aggregate view is a later optimization if it grows.
- `app/city/[id]/page.tsx` (server) fetches that city + its florists, renders the
  existing `DashboardClient`.

## Build split

- **backend-engineer:** `cities.region` column + migration + `geocode.py` region
  capture + `db.py`/`main.py` passthrough + `backfill_regions.py`.
- **frontend-engineer:** new `/` Overview+Hub, move the map dashboard to
  `/city/[id]`, `lib/stats.ts` (+ a small sanity test), relocate `AddCityForm`,
  wire per-card re-run and drill-in, `lib/types.ts` `region`.

## Non-goals

No real email sending / reply tracking here (that's #3 — the sent/reply stats are
placeholders). No new auth. No Postgres aggregate view yet (client-side is fine at
POC scale). No region editing UI (region comes from geocoding).
