# Permanent per-florist exclude

Date: 2026-07-02. Adds a permanent denylist for individual florists: exclude a
scrape false-positive (e.g. "hip&love", a lifestyle brand that keeps matching the
florist search) so it's hidden AND never re-added on future scrapes — unlike the
reset soft-delete, which resurrects anything the scrape returns.

## Concept: `excluded_at` vs `deleted_at`

- `deleted_at` (existing) — reset-re-run soft-delete. A florist that reappears in a
  later scrape is resurrected (`deleted_at` cleared on upsert).
- `excluded_at` (new) — permanent exclusion. Hidden in the dashboard, and the ingest
  drops its `place_id` from the scrape before persisting, so it never comes back.

## 1. Data model

```sql
alter table florists add column if not exists excluded_at timestamptz;
```

Migration file + `schema.sql` parity. Nullable, null = not excluded. No index (POC scale).

## 2. Read filter

Both dashboard florist reads add `.is("excluded_at", null)` alongside the existing
`.is("deleted_at", null)`:
- `dashboard/app/page.tsx` (overview)
- `dashboard/app/city/[id]/page.tsx` (city)

An excluded florist disappears from the dashboard and from all stats/counts (computed
from the fetched rows).

## 3. Ingest skip (makes it permanent)

- New `db.py::get_excluded_place_ids(client, city_id) -> set[str]` — `select place_id
  from florists where city_id = X and excluded_at is not null`.
- `main.py`: right after the scrape + dedup (after `[3/7]`, before `[4/7]` distance),
  filter the scraped list:
  ```python
  excluded = get_excluded_place_ids(db, city_id)
  before = len(florists)
  florists = [f for f in florists if f["place_id"] not in excluded]
  if before != len(florists):
      _echo(f"      Skipped {before - len(florists)} excluded florist(s).", job_id, db)
  ```
- Because the filter runs before the bare-row persist and the per-florist upsert, an
  excluded florist is never re-persisted or resurrected — on any future run, reset or
  not. Its existing row keeps `excluded_at` set (stays hidden).

## 4. Write path — service-role API route (decision A)

The dashboard is otherwise RLS-read-only (anon key + JWT). Excluding needs a write, and
`florists` has no update policy. We add a **server-only service-role path** (also the
foundation the outreach CRM will reuse for its writes):

- `dashboard/lib/supabase.ts` gains `createServiceClient()` — a Supabase client built
  with `SUPABASE_SERVICE_ROLE_KEY` (server-only env, never `NEXT_PUBLIC_`). Bypasses RLS;
  only ever used inside auth-gated API routes.
- Add `SUPABASE_SERVICE_ROLE_KEY` to `dashboard/.env.local` (gitignored) + document it in
  the dashboard env notes.
- New route `dashboard/app/api/florists/exclude/route.ts` (POST `{ floristId: string }`),
  Node runtime, `dynamic = "force-dynamic"`:
  1. Auth-gate: `getUser()` + `isAllowed(user.email)` (same pattern as `/api/jobs`,
     `/api/ingest`) — 401/403 otherwise.
  2. Validate `floristId` is a non-empty string (UUID-shaped).
  3. Service-role client: `update florists set excluded_at = now() where id = floristId`.
  4. Return `{ ok: true }` (or 404 if no row matched).

`CLAUDE.md` updated: the dashboard now holds the service-role key for a narrow set of
auth-gated server-side writes (exclude, and the coming outreach records), while all
*reads* stay on the anon key + JWT under RLS.

## 5. UI — per-florist exclude action

- In the city page's florist **detail drawer** (the panel shown when a florist row is
  selected), add a low-emphasis **"Exclude this florist"** action at the bottom, with a
  one-step inline confirm (click → "Permanently exclude? — hidden and skipped on future
  scrapes" → Confirm/Cancel). Not a browser `confirm()` dialog (those block automation);
  an inline two-state button or a small confirm popover.
- On confirm → `POST /api/florists/exclude { floristId }` → on success close the drawer +
  `router.refresh()` so the florist disappears. Error → a toast.
- Copy makes the permanence explicit; distinct from the reset soft-delete.

## 6. Edge cases

- Excluding a florist that's currently the selected/active one → drawer closes, row gone
  after refresh.
- An excluded florist is also `deleted_at`-marked by a later reset's `soft_delete_city_
  florists` (it sets `deleted_at` on all active rows) — harmless: it's filtered from the
  scrape and stays hidden by `excluded_at` regardless.
- Re-including is out of scope (SQL: `update florists set excluded_at = null …`).

## 7. Verification

- Migration applied; `excluded_at` live.
- Exclude "hip&love" in Sabadell from the UI → it vanishes from the city page + overview
  counts drop by 1.
- Re-run Sabadell (with AND without reset) → the job log shows "Skipped 1 excluded
  florist(s)", and "hip&love" does NOT reappear.
- Signed-out: excluded rows never leak (RLS + filter).

## 8. Non-goals

No un-exclude UI (SQL-recoverable). No bulk exclude (per-row only). No exclude from the
overview (city page only). Exclusion is per-florist by `place_id` within its city (the
same `place_id` in a different city is independent).

## Build split

- **backend-engineer** → `ingest/` + `supabase/`: `excluded_at` migration + schema,
  `db.py::get_excluded_place_ids`, `main.py` scrape-time skip.
- **frontend-engineer** → `dashboard/`: `.is("excluded_at", null)` on both reads,
  `lib/supabase.ts::createServiceClient` + `.env.local` key, `/api/florists/exclude`
  route, the exclude action in the city detail drawer, `CLAUDE.md` note.
