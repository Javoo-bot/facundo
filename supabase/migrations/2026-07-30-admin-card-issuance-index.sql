-- Follow-up to 2026-07-30-admin-card-issuance.sql: the final-review fix wave made
-- payouts.florist_id a real query-filter column (guardExposureAndFunds, the florist
-- detail page, the florists list page all now `.eq("florist_id", ...)` on it) — index it.
create index if not exists payouts_florist_id_idx on payouts (florist_id) where florist_id is not null;
