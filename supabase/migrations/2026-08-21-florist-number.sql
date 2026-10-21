-- Facundo-minted "Florist ID" — a 7-digit integer WE generate per florist,
-- not something copied in from an external system. We're moving off Odoo's own
-- numbering while keeping the same downstream Shopify field name for backward
-- compat (see the mapping comment in dashboard/lib/shopifyWriteback.ts — our
-- name here is deliberately plain; the Shopify metafield name lives ONLY over
-- there).
--
-- Nullable: most florists won't have one until staff decide to assign it.
-- `unique` so two florists can never collide within our own system, regardless
-- of how the value got there (minted here, or hand-set later for some reason).
alter table florists add column if not exists florist_number integer unique;

comment on column florists.florist_number is
  'Facundo-minted Florist ID (7-digit integer), assigned per-shop by staff via assign_florist_number() for florists that never had one; a known florist''s real existing id is entered by hand instead (staff-editable either way). Written back to Shopify under the "Tookan Florist Id" metafield (custom.tookan_florist_id) — confirmed live 2026-08-21; NOT "Odoo Florist Order Id" (custom.odoo_florist_order_id), which real order data shows tracks the ORDER, not the florist. See dashboard/lib/shopifyWriteback.ts for the our-name -> Shopify-name mapping and dashboard/lib/floristNumber.ts for the reserved-range constant (must move together with this sequence''s start value).';

-- ============================================================================
-- RESERVED BLOCK — a considered default, not confirmed against a real range
-- ============================================================================
-- 9000000 was chosen against the numeric spaces we DID find live on
-- 2026-08-21: Odoo order ids (~1.5 million) and Odoo supplier/vendor ids
-- (76276006, 300445 real; 999999999 as an apparent placeholder). The actual
-- target field, custom.tookan_florist_id, was checked across 66 real orders
-- (oldest + newest sampled) and was unpopulated on every one — there is no
-- live value to confirm this range against, only the field's existence. If
-- Tookan is ever revived and starts writing real values here, re-check this
-- offset against whatever it actually uses (and
-- dashboard/lib/floristNumber.ts's FLORIST_NUMBER_RESERVED_START, which
-- mirrors this value and must be updated alongside it).
-- ============================================================================
create sequence if not exists florist_number_seq
  start with 9000000
  increment by 1
  minvalue 9000000;

-- Atomically mint-or-return a florist's number, as a SINGLE statement rather
-- than a check-then-act (select, branch, then a separate update) — the
-- earlier version of this function had exactly that race: two concurrent
-- calls for the same florist could both read florist_number as null, both
-- nextval() the sequence, and then the second UPDATE (unconditional, once it
-- got the row lock) would silently clobber the first mint, burning/orphaning
-- one sequence value and returning a number to the losing caller that was
-- never actually persisted.
--
-- The UPDATE below closes that: `coalesce(florist_number, nextval(...))`
-- means nextval() only fires when the column is still null, and the row lock
-- the UPDATE takes serializes concurrent callers for the same florist — the
-- second caller blocks until the first commits, then reads the now-non-null
-- florist_number and coalesce short-circuits before calling nextval() again.
-- So: idempotent (repeat calls for an already-numbered florist never touch
-- the sequence) AND race-safe (concurrent first-time calls for the same
-- florist mint exactly once and agree on the returned value).
--
-- Returns null if p_florist_id doesn't match any row — the RETURNING clause
-- simply has nothing to return. The assign-number route already 404s on a
-- separate existence check before calling this RPC, so callers should not
-- rely on this null as their primary "not found" signal; it's defense in
-- depth only.
--
-- Runs security definer so the app can call it via RPC without granting raw
-- sequence/table access — restricted to service_role below (see the grant
-- statement), matching every other security-definer function in this repo
-- (e.g. bump_magic_token_use in 2026-08-04-florist-magic-links.sql,
-- run_readonly_stats_query in 2026-08-05-stats-reader-role.sql): a
-- security-definer function bypasses RLS for its duration, and `florists`
-- only has a SELECT policy (supabase/schema.sql) — no insert/update policy —
-- so without this restriction, CREATE FUNCTION's implicit PUBLIC grant would
-- let anyone holding the (public, per CLAUDE.md) anon key mint florist
-- numbers directly via PostgREST, bypassing the assign-number route's
-- requireRole("ops","admin") gate entirely.
create or replace function assign_florist_number(p_florist_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_number integer;
begin
  update florists
     set florist_number = coalesce(florist_number, nextval('florist_number_seq'))
   where id = p_florist_id
  returning florist_number into v_number;

  return v_number;
end;
$$;

-- The dashboard route (app/api/florists/assign-number/route.ts) calls this
-- through the service-role client, which already bypasses RLS — no grant to
-- anon/authenticated, so it stays unreachable from the browser even though
-- it's security definer.
revoke all on function assign_florist_number(uuid) from public, anon, authenticated;
grant execute on function assign_florist_number(uuid) to service_role;

-- NO BACKFILL: existing florists are intentionally left with florist_number =
-- null. Assigning one is a per-shop staff decision (via the assign-number
-- endpoint), not something to do silently to the whole table.
