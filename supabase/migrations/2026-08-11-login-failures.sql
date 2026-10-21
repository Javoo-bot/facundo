-- One row per FAILED sign-in attempt. The counterpart to login_events, which
-- records only successes.
--
-- Why a separate table rather than a `failure_reason` column on login_events:
-- login_events is already aggregated by the Statistics page —
-- `count(*) from login_events where surface = 'staff'` is the staff
-- logins-per-day series in 2026-08-05-ops-stats-functions.sql — and it is
-- described to the SQL chat (lib/statsChat.ts) as "every staff/florist
-- sign-in". Adding failure rows there would silently inflate a shipped metric
-- and make that description false. This table is purely additive: nothing
-- that exists today reads it.
--
-- Motivating incident (2026-08-11): a staff member opening the app from a
-- Google Chat link could never sign in. The chat app's in-app browser held the
-- PKCE code verifier and Google handed the redirect to the system browser, so
-- exchangeCodeForSession failed every time. Diagnosing it took a manual
-- comparison of auth.users.last_sign_in_at against login_events, because a
-- failure left no trace anywhere. `user_agent` alone would have named the
-- cause: the in-app browser is a distinct UA string.
--
-- DELIBERATELY NO CHECK CONSTRAINTS on stage/reason. These inserts are
-- best-effort diagnostics (lib/loginFailures.ts swallows errors so logging can
-- never cost anyone a sign-in), so a value the constraint didn't anticipate
-- must not turn into a silently dropped row — which is exactly the trap the
-- login_events migration flagged for its own `method` check.

create table login_failures (
  id          uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  -- Where in the flow it broke: 'code_exchange' (a code arrived but could not
  -- be exchanged), 'no_code' (the callback was reached with nothing to
  -- exchange), 'not_allowed' (a real session, rejected by the allow list).
  stage       text not null,
  -- Provider error code, e.g. 'pkce_code_verifier_not_found'. Null when the
  -- stage has no provider error of its own.
  reason      text,
  -- Provider message, truncated by the caller. The human-readable half.
  detail      text,
  -- Known only when a session was actually established (stage 'not_allowed').
  -- Null for an exchange failure: there is no user yet to name.
  user_email  text,
  -- Host the attempt came in on, so bo./florist./legacy hosts are separable.
  host        text,
  -- The callback's `next` param. '/auth/reset' means this was a password
  -- reset, NOT a sign-in — /auth/forgot routes staff AND florists through the
  -- same callback (app/florist/login/page.tsx links it too), so without this
  -- an expired reset link is indistinguishable from a failed Google sign-in.
  next_param  text,
  -- The single most diagnostic field: names in-app browsers (Google Chat,
  -- Slack, Teams) that start a flow they cannot finish.
  user_agent  text
);

create index login_failures_occurred_idx on login_failures(occurred_at desc);

alter table login_failures enable row level security;
create policy "allowlisted read login_failures" on login_failures
  for select to authenticated using (public.is_email_allowed());
-- No write policy: inserts are service-role only, from the callback route.

-- Let the Statistics SQL chat read it, same as login_events (see
-- 2026-08-05-stats-reader-role.sql for why this role exists and what it may
-- see). Read-only, and the table holds no secrets — an email and a UA string.
grant select on table login_failures to stats_reader;
