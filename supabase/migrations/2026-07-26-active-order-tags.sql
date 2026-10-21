-- Active-order-tags: an opt-in filter so only Shopify orders carrying one of a
-- staff-configured set of tags get matched/worked (and shown by default) —
-- ingest itself is unaffected, every order still lands in `orders`.
--
-- Semantics (see dashboard/lib/orderTags.ts + ingest-worker/src/tags.ts
-- ::hasActiveTag, the single source of truth for the matching logic):
--   - '{}' (empty array, the default) = NO filtering. Every order is matched
--     and shown, exactly as before this column existed. This keeps the
--     feature fully backward-compatible until a staff member opts in from
--     Settings → Active order tags.
--   - Non-empty = only orders whose comma-split `orders.tags` intersects this
--     set (case-insensitive, trimmed) are matched by the ingest worker and
--     surfaced in the CX attention queue / orders list default view. Orders
--     that don't match stay ingested at status 'received' — visible in the
--     full orders list, just not auto-worked.
alter table app_settings
  add column if not exists active_order_tags text[] not null default '{}';

comment on column app_settings.active_order_tags is
  'Opt-in tag allow-list gating order matching. Empty = match/show every order (default, backward-compatible). Non-empty = only orders whose Shopify tags intersect this set are matched and shown by default; others are ingested but left at status ''received''.';
