-- Soft delete for florists (delete-first re-run reset). null = active,
-- non-null = hidden. Rows are never hard-deleted; a reappearing florist is
-- resurrected by the ingest upsert (which sets deleted_at = null).
alter table florists add column if not exists deleted_at timestamptz;
