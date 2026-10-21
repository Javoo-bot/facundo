-- Florist self-registration ("join our network"): a token-gated public form
-- (dashboard/app/florist/accept/[token]) lets a florist confirm their own
-- contact details and set a next-day-delivery cutoff. Opening hours reuse the
-- existing `business_hours` jsonb column — no new hours field here.
alter table florists
  add column if not exists join_token             text unique,
  add column if not exists join_token_expires_at   timestamptz,
  add column if not exists joined_at               timestamptz,
  add column if not exists next_day_cutoff_hour    integer;

alter table florists drop constraint if exists florists_next_day_cutoff_hour_check;
alter table florists add constraint florists_next_day_cutoff_hour_check
  check (next_day_cutoff_hour is null or next_day_cutoff_hour in (11, 12, 13, 14, 15));

comment on column florists.join_token is
  'Opaque token for the no-login "join our network" link (dashboard/app/florist/accept). Minted lazily by app/api/florists/draft-email when a recruiting draft is generated, via lib/floristJoin.ts::needsNewJoinToken.';
comment on column florists.join_token_expires_at is
  '30 days from mint (lib/floristJoin.ts::joinTokenExpiry). A live recruiting-draft regeneration refreshes it once expired.';
comment on column florists.joined_at is
  'Set by app/api/florist/accept on successful self-registration. Null = not yet joined; non-null makes the accept link idempotent (read-only confirmation instead of the form).';
comment on column florists.next_day_cutoff_hour is
  'Florist-set next-day-delivery order cutoff, one of 11/12/13/14/15. Null until the florist submits the accept form.';
