-- One row per successful sign-in, staff or florist. Nothing in this stack
-- records sign-ins today (only client-side PostHog) — this is the source of
-- truth for the Statistics page's Usage/Logins sections and the SQL chat.
-- See docs/superpowers/specs/2026-08-05-statistics-and-insights-design.md.
--
-- NOTE: the spec's login_events SQL omits 'otp' from the method check
-- ('google','password','magic_link' only), but the florist login page
-- (app/florist/login/page.tsx) has a genuine email-OTP sign-in flow distinct
-- from both password and magic-link, and lib/loginEvents.ts's LoginMethod
-- type includes it — omitting it here would silently drop every OTP login
-- from the check constraint (the best-effort insert would just fail). Per
-- the implementation plan's own tie-break rule ("where plan and spec
-- disagree, the spec wins — flag it rather than silently picking one"): this
-- is flagged, and 'otp' is kept since dropping it breaks a real, shipped
-- sign-in path.

create table login_events (
  id          uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  surface     text not null check (surface in ('staff', 'florist')),
  user_email  text,
  florist_id  uuid references florists(id) on delete set null,
  method      text not null check (method in ('google', 'password', 'otp', 'magic_link')),
  user_agent  text
);
create index login_events_occurred_idx on login_events(occurred_at desc);
create index login_events_florist_idx on login_events(florist_id, occurred_at desc);

alter table login_events enable row level security;
create policy "allowlisted read login_events" on login_events
  for select to authenticated using (public.is_email_allowed());
-- No write policy: inserts are service-role only, from each sign-in call site.
