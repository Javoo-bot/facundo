# Edit florist contact/basic info

Date: 2026-07-30. Lets ops/admin staff correct a florist's contact and basic-info
fields directly from the florist detail page, instead of only being able to fix them
via a manual DB edit. Prompted by a real case: the ingest pipeline's email extractor
mangled `concepciónperez@correo-demo.es` into a broken value (see the sibling
bug fix to `EMAIL_REGEX` in `ingest/enrich.py` / `ingest-worker/src/config.ts` — that
fix stops it happening again, this feature lets staff fix rows that already have it).

## 1. Scope

Editable: `name`, `address`, `email`, `phone_web`, `phone_maps`, `owner_name`,
`website_url` — the fields most exposed to scraping/enrichment error.

Not in scope: enrichment judgment fields (`is_ecommerce`, `ecommerce_signals`,
`shop_highlight`, `enrichment_notes`) and anything already editable via
`app/api/florists/operational/route.ts` (`trust_tier`, `delivery_radius_km`,
`capacity_per_day`, `business_hours`, `payout_terms`, `source`, `locale`) or
`app/api/florists/stage/route.ts` (`lifecycle_stage`). Geocoded/Google-sourced fields
(`lat`, `lng`, `rating`, `review_count`, `distance_km_from_center`) stay read-only.

## 2. API

New route `app/api/florists/details/route.ts`, `POST`, mirroring the shape of
`operational/route.ts`:

- Gate: `requireRole("ops", "admin")` (`lib/apiAuth.ts`) — same as the existing
  "Operational" section on this page.
- Body: `{ floristId, name?, address?, email?, phone_web?, phone_maps?, owner_name?,
  website_url? }` — a field absent from the body must not null out the stored value
  (partial update, same convention as `operational/route.ts`).
- Validation:
  - `name`: if present, must be a non-empty trimmed string (this column is `not null`
    in the schema — never allow clearing it to empty/null).
  - `email`: if present, must be `null` or match the dashboard's existing permissive
    pattern `/^[^@\s]+@[^@\s]+\.[^@\s]+$/` (already used across
    `lib/offerVars.ts`/`lib/clientComms.ts`/etc.) — this pattern is unicode-tolerant
    and accepts accented local parts like the `concepción…` address; do not introduce
    a stricter ASCII-only check.
  - `address`, `phone_web`, `phone_maps`, `owner_name`, `website_url`: free-text
    strings or `null`, trimmed; empty string stored as `null`.
- On update: fetch the current row first, diff old vs. new for only the fields
  present in the body, and if anything actually changed, insert one combined note
  into `florist_notes` (`author` = staff email, `body` = e.g. `Updated details —
  email: "old" → "new"; phone_web: "old" → "new"`). This insert is best-effort — a
  failure here logs to console but does not fail the request, matching how
  `florist_tier_changes` audit failures are handled in `operational/route.ts`.
- Errors: `400` invalid JSON / no recognized fields / failed validation, `404` florist
  not found, `500` on the update query failing — same `jsonError` helper used
  throughout `app/api/florists/*`.

## 3. UI

In `components/florist/FloristCardClient.tsx`, the header block that currently
renders static `name` / `email` / `phone` / `website_url` / `address` (around
lines 317–345) gains an inline edit toggle, gated on the existing `canSeeOperational`
prop (no new prop needed — this is the same ops/admin gate already threaded through
from the server page).

- Default: read-only display, as today, plus a small edit affordance next to the
  name (pencil icon or "Edit" text link) visible only when `canSeeOperational`.
- Clicking it swaps the static spans for text inputs (pre-filled with current
  values) plus Save/Cancel buttons, using the component's existing `busy`/`post()`
  helper pattern (same one the Operational section and stage selector already use).
- Save posts to `/api/florists/details`; on success, close edit mode and refresh
  (same `router.refresh()` convention used elsewhere on this page). On failure,
  surface the server's error message inline (matches the existing `err` state
  pattern used by the Operational form).
- Cancel discards local edits and reverts to read-only display without a request.

## 4. Testing

One lightweight `node --test` file (matching the repo's existing thin-test
convention — see the staff-roles/florist-invite guard tests) covering:

- the role gate rejects a non-ops/admin caller;
- the email regex accepts a unicode local part (`concepciónperez@correo-demo.es`)
  and rejects an obviously malformed string (no `@`);
- an empty `name` is rejected.

No end-to-end/browser test — verification is manual: sign in as an ops/admin staff
account, edit a florist's email to a unicode address, confirm it saves, reload, and
confirm a florist_notes entry recorded the change.
