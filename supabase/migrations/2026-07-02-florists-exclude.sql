-- Permanent per-florist exclusion (denylist). null = not excluded.
-- Distinct from deleted_at (reset soft-delete): an excluded florist is hidden
-- AND dropped from every future scrape, so it never comes back.
alter table florists add column if not exists excluded_at timestamptz;
