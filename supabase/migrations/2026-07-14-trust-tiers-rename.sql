-- Phase 0 — rename trust tier codes Z/Y/X/K -> 1/2/3/4.
-- Mapping preserves the existing best->worst trust ordering and labels:
--   Z (Trusted) -> 1,  Y (Known) -> 2,  X (New) -> 3,  K (Flagged) -> 4.
-- Deploy note: apply this WITH the dashboard/ingest code that expects 1-4, and
-- BEFORE re-seeding — the seed files now insert '1'..'3'. Idempotent (safe re-run):
-- the value CHECK constraints are dropped, values remapped (the else-branch keeps
-- already-migrated 1-4 untouched), then the constraints re-added.

-- 1. Drop the old value CHECK constraints (Postgres auto-names inline column
--    checks <table>_<column>_check).
alter table trust_tiers drop constraint if exists trust_tiers_code_check;
alter table florists   drop constraint if exists florists_trust_tier_check;

-- 2. Remap existing values in place. trust_tiers.code is the PK but nothing
--    references it via a foreign key (florists.trust_tier is a plain checked
--    text column), so the PK update is safe.
update trust_tiers set code = case code
  when 'Z' then '1' when 'Y' then '2' when 'X' then '3' when 'K' then '4' else code end;
update florists set trust_tier = case trust_tier
  when 'Z' then '1' when 'Y' then '2' when 'X' then '3' when 'K' then '4' else trust_tier end
  where trust_tier is not null;

-- 3. Re-add the CHECK constraints with the new allowed set.
alter table trust_tiers add constraint trust_tiers_code_check   check (code in ('1','2','3','4'));
alter table florists   add constraint florists_trust_tier_check check (trust_tier in ('1','2','3','4'));
