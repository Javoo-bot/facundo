-- Replaces the Statistics chat's SQL sandbox (run_readonly_stats_query) with a
-- database-enforced privilege boundary. Supersedes the blocklist version in
-- 2026-08-05-run-readonly-stats-query.sql, which was inadequate three ways —
-- all three reproduced against this database before the change:
--
--   1. The blocklist matched four table *names* as text, so any spelling that
--      isn't that literal text slipped through. `select count(*) from
--      U&"allowed_\0065mails"` returned 9 rows.
--   2. `set search_path = public` only constrains *unqualified* names, so
--      schema-qualified reads were never in its scope at all.
--      `select count(*) from auth.users` returned 13;
--      `auth.refresh_tokens` returned 169.
--   3. `security definer` ran the query as the owner (postgres, which has
--      BYPASSRLS), so the tables we deliberately made service-role-only by
--      enabling RLS and writing no policy at all — florist_magic_tokens,
--      florist_invites — were readable anyway.
--
-- The fix inverts the model: stop enumerating what is forbidden, enumerate what
-- is permitted, and let Postgres enforce it. A dedicated NOLOGIN role,
-- `stats_reader`, holds select on exactly the 13 tables the chat's system
-- prompt advertises and nothing else; model-generated SQL is executed by a
-- function *owned by that role*, so those grants are the entire reachable
-- surface. A table added to this schema in future is inaccessible to the chat
-- by default — Supabase's default privileges grant new tables to
-- anon/authenticated/service_role only, never to stats_reader.
--
-- KEEP IN SYNC: the 13-table grant list below is the same list as
-- SCHEMA_CONTEXT in dashboard/lib/statsChat.ts. Changing one without the other
-- either advertises a table the chat cannot read, or grants one it was never
-- told about. See
-- docs/superpowers/specs/2026-08-05-statistics-and-insights-design.md §3.
--
-- EXTENDED, not superseded, by 2026-08-06-stats-chat-sms-tables.sql, which adds
-- short_links and sms_events as tables 14 and 15. Those two are granted per
-- COLUMN rather than whole (each holds a credential), so they are not in the
-- list below; the pairing with SCHEMA_CONTEXT now spans both files.

-- ---------------------------------------------------------------------------
-- 1. The role.
-- ---------------------------------------------------------------------------
-- NOLOGIN: nothing ever authenticates as stats_reader. It is only ever entered
-- by owning the sandbox function in section 3.
--
-- BYPASSRLS is deliberate and load-bearing, not laziness. All 13 tables have
-- RLS enabled with policies written `to authenticated using
-- (public.is_email_allowed())`. stats_reader is not a member of `authenticated`
-- and carries no JWT, so without BYPASSRLS no policy would ever apply to it and
-- every analytics query would return zero rows — the feature would be dead.
-- Moving the boundary from RLS to the GRANT list is the point of this change:
-- one list, in one file, that an auditor can read top to bottom. The role holds
-- no other privilege, cannot log in, and is reachable only through the one
-- function below.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'stats_reader') then
    alter role stats_reader nologin bypassrls;
  else
    create role stats_reader nologin bypassrls;
  end if;
end
$$;

-- postgres needs membership to hand the sandbox function over to stats_reader
-- (ALTER FUNCTION ... OWNER TO requires membership in the new owner) and to
-- CREATE OR REPLACE it afterwards on a re-apply (that requires the privileges
-- *of* the owner, hence `inherit true`). This grants postgres nothing it did
-- not already have — it is the owner of every table in the list and has
-- BYPASSRLS itself, so it strictly dominates stats_reader.
grant stats_reader to postgres with inherit true, set true;

-- ---------------------------------------------------------------------------
-- 2. The allowlist: usage on public, select on exactly 13 tables.
-- ---------------------------------------------------------------------------
-- Note what is absent, and must stay absent: no usage on schema `auth`, so
-- auth.users / auth.refresh_tokens fail at the schema boundary before any table
-- privilege is even considered; and no grant on florist_magic_tokens,
-- florist_invites, allowed_emails, staff_roles, admin_card_issuance,
-- payment_events, app_settings, or anything else in public.
grant usage on schema public to stats_reader;

grant select on table
  orders,               -- 1
  order_line_items,     -- 2
  order_assignments,    -- 3
  delivery_events,      -- 4
  florists,             -- 5
  order_issues,         -- 6
  communications,       -- 7
  email_events,         -- 8
  login_events,         -- 9
  cities,               -- 10
  trust_tiers,          -- 11
  payouts,              -- 12
  outreach              -- 13
to stats_reader;

-- ---------------------------------------------------------------------------
-- 3. The sandbox function, owned by stats_reader.
-- ---------------------------------------------------------------------------
-- Why a second schema instead of `set local role stats_reader` inside the
-- existing function, as one might expect: Postgres refuses it —
-- `SET ROLE` inside a SECURITY DEFINER function raises
--   cannot set parameter "role" within security-definer function
-- (verified against this database). The equivalent that Postgres *does* allow
-- is to make the executing function itself owned by the restricted role, which
-- is what happens here. ALTER FUNCTION ... OWNER TO requires the new owner to
-- hold CREATE on the function's schema, so the function lives in its own
-- `stats_sandbox` schema rather than in `public` — stats_reader gets CREATE
-- there and nowhere else. `stats_sandbox` is not on any search_path.
create schema if not exists stats_sandbox;
revoke all on schema stats_sandbox from public;
grant usage, create on schema stats_sandbox to stats_reader;

-- The 500-row cap no longer interpolates caller text into a wrapper statement.
-- The old form,
--   format('... from (select * from (%s) sub limit 500) t', q)
-- put model-generated text *inside* our statement, so text that closed our
-- parentheses and commented out the tail rewrote the statement and the cap
-- stopped applying — `select id from orders) sub limit 5000) t --` returned
-- 3988 rows against a 500 cap. Here `q` is opened as a cursor in its own right
-- and at most 500 rows are fetched from it. `q` is never concatenated with
-- anything, so the only thing caller text can do is be valid or invalid SQL —
-- it can no longer change the cap, the role, or anything else about how it runs.
create or replace function stats_sandbox.fetch_capped(q text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cur      refcursor;
  rec      record;
  fetched  jsonb[] := '{}';
  n        integer := 0;
  -- Real wall-clock budget. See the note on statement_timeout in
  -- run_readonly_stats_query below for why this is here and not left to that.
  deadline timestamptz := clock_timestamp() + interval '5 seconds';
begin
  open cur for execute q;
  loop
    fetch cur into rec;
    exit when not found;
    fetched := fetched || to_jsonb(rec);
    n := n + 1;
    exit when n >= 500;
    if clock_timestamp() > deadline then
      -- Raise rather than return what we have: a silently truncated result set
      -- is a wrong answer the chat would then narrate as fact.
      raise exception 'stats query exceeded its 5s row-fetch budget';
    end if;
  end loop;
  close cur;

  return coalesce(to_jsonb(fetched), '[]'::jsonb);
end;
$$;

alter function stats_sandbox.fetch_capped(text) owner to stats_reader;
revoke all on function stats_sandbox.fetch_capped(text) from public;
grant execute on function stats_sandbox.fetch_capped(text) to postgres;

-- ---------------------------------------------------------------------------
-- 4. The entry point PostgREST sees, unchanged in name and signature.
-- ---------------------------------------------------------------------------
-- Owned by postgres and granted only to service_role, so the sandbox function
-- has exactly one caller.
--
-- transaction_read_only is real defense in depth: stats_reader already holds no
-- insert/update/delete anywhere, but a read-only transaction additionally blocks
-- any write reachable through a SECURITY DEFINER function the query might call.
-- Verified: current_setting('transaction_read_only') reads 'on' inside the
-- sandbox.
--
-- statement_timeout, honestly: setting it here does NOT bound the query we are
-- about to run. Postgres arms the statement timer when the top-level statement
-- begins, and changing the GUC afterwards does not re-arm it — verified, a
-- `select pg_sleep(10)` ran to completion with statement_timeout reading '5s'
-- inside the function. It is kept because it costs nothing and does bound any
-- later statement in the same transaction, but the controls that actually bound
-- a runaway query are (a) the 500-row fetch cap and 5s wall-clock deadline in
-- stats_sandbox.fetch_capped above, and (b) the 8s statement_timeout Supabase
-- sets on `authenticator`, which PostgREST arms for real at statement start
-- (verified: an outer 2s timeout cancelled this function at 2.0s).
create or replace function run_readonly_stats_query(q text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('statement_timeout', '5000', true);
  perform set_config('transaction_read_only', 'on', true);

  return stats_sandbox.fetch_capped(q);
exception
  when others then
    -- Returned rather than raised so the chat model sees the error text and can
    -- correct its own query. A blocked table surfaces here as e.g.
    -- "permission denied for table florist_magic_tokens".
    return jsonb_build_object('error', sqlerrm);
end;
$$;

revoke all on function run_readonly_stats_query(text) from public;
grant execute on function run_readonly_stats_query(text) to service_role;
