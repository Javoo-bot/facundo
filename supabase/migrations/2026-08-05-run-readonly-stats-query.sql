-- SUPERSEDED by 2026-08-05-stats-reader-role.sql, which runs later in filename
-- order and replaces this function outright. Everything below was reproduced as
-- bypassable against the live database — the table blocklist doesn't survive
-- identifier escaping, `set search_path` doesn't constrain schema-qualified
-- names such as `auth.*`, `security definer` bypasses the RLS that makes
-- florist_magic_tokens/florist_invites service-role-only, and the `format()`
-- row-cap wrapper can be closed off by the caller's own text. Kept only so the
-- migration history stays a truthful record; do not model new work on it.
--
-- Guarded read-only SQL executor for the Statistics chat. Called via the
-- service-role client, never exposed directly to the browser. Two layers of
-- defense beyond the app-level regex gate in lib/statsChatGuard.ts:
--   1. security definer + explicit restricted-table check, so even a gate
--      bypass can't reach allowed_emails / staff_roles / admin_card_issuance /
--      payment_events.
--   2. an actual read-only transaction + statement timeout, enforced by
--      Postgres itself, not just application code.
-- See docs/superpowers/specs/2026-08-05-statistics-and-insights-design.md.

create or replace function run_readonly_stats_query(q text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if q ~* '\m(allowed_emails|staff_roles|admin_card_issuance|payment_events)\M' then
    raise exception 'query references a restricted table';
  end if;

  perform set_config('statement_timeout', '5000', true);
  perform set_config('transaction_read_only', 'on', true);

  execute format(
    'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) sub limit 500) t',
    q
  ) into result;

  return result;
exception
  when others then
    return jsonb_build_object('error', sqlerrm);
end;
$$;

revoke all on function run_readonly_stats_query(text) from public;
grant execute on function run_readonly_stats_query(text) to service_role;
