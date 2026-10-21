-- Facundo POC schema
-- Run this in the Supabase SQL editor for a fresh project.
-- (For an already-provisioned project, use supabase/migrations/ instead.)
--
-- The florist/city data is gated by an allow-list enforced AT THE DATABASE via
-- RLS — not just in the app. Because the Supabase URL + anon key are public, an
-- app-layer-only check can be bypassed by driving auth directly against Supabase;
-- the `is_email_allowed()` policy below closes that.

create table cities (
  id             uuid primary key default gen_random_uuid(),
  country        text not null,
  city           text not null,
  center_lat     double precision not null,
  center_lng     double precision not null,
  radius_km      double precision,             -- search radius used for the latest ingest; null for rows ingested before radius-based scraping
  region         text,                         -- administrative region/state from Nominatim (state/province/region/state_district); null when unavailable or not yet backfilled
  ingested_at    timestamptz not null default now(),
  unique (country, city)
);

-- Migration for existing DBs: alter table florists add column if not exists shop_highlight text;
create table florists (
  id                      uuid primary key default gen_random_uuid(),
  city_id                 uuid not null references cities(id) on delete cascade,
  place_id                text not null,                -- Google Maps place_id, dedup key
  name                    text not null,
  address                 text,
  lat                     double precision,
  lng                     double precision,
  rating                  double precision,             -- e.g. 4.6
  review_count            integer,
  distance_km_from_center double precision,             -- computed at ingest
  -- Maps-native fields
  phone_maps              text,
  website_url             text,
  -- Enrichment fields (nullable — flag when unknown, do not fake)
  has_website             boolean not null default false,
  is_ecommerce            boolean,                       -- null = unknown
  ecommerce_signals       jsonb,                         -- {"platform": "shopify", "cart_link": true, ...}
  email                   text,                          -- best-guess primary
  phone_web               text,                          -- from website, if found
  owner_name              text,                          -- often null
  shop_highlight          text,                          -- one distinctive detail for outreach personalization; null if none
  enrichment_notes        text,                          -- free-form: what was tried, why failed
  drafted_email           text,                          -- generated outreach draft
  order_sms_opt_out       boolean not null default false,
  order_sms_snoozed_until timestamptz,
  drafted_sms             text,                          -- generated recruiting SMS draft
  ingested_at             timestamptz not null default now(),
  deleted_at              timestamptz,                   -- null = active; non-null = soft-deleted (hidden)
  excluded_at             timestamptz,                   -- null = active; non-null = permanently excluded (hidden + skipped by ingest)
  lifecycle_stage         text not null default 'found',  -- pipeline: found·targeted·contacted·engaged·onboarding·production·lost
  unique (city_id, place_id)
);

-- Allow-list of demo emails. The security-critical source of truth for read
-- access. Managed via the service role only (see the note on RLS below).
create table allowed_emails (
  email text primary key
);

-- Is the caller's JWT email on the allow-list? SECURITY DEFINER so the policy can
-- read allowed_emails even though the caller has no direct SELECT grant on it
-- (allowed_emails has RLS enabled with no policies, so it is otherwise unreadable).
create or replace function public.is_email_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from allowed_emails
    where email = (auth.jwt() ->> 'email')
  );
$$;

alter table cities         enable row level security;
alter table florists       enable row level security;
alter table allowed_emails enable row level security;
-- allowed_emails intentionally has NO policies: unreadable/unwritable by the
-- anon and authenticated roles; only the service role (which bypasses RLS)
-- manages it. This also prevents an authenticated user from reading the list.

create policy "allowlisted read cities"   on cities   for select to authenticated using (public.is_email_allowed());
create policy "allowlisted read florists" on florists for select to authenticated using (public.is_email_allowed());

-- Seed the allow-list. Keep this in sync with the dashboard's ALLOWED_EMAILS env
-- var (the env var drives the friendly "not authorized" bounce in the app; this
-- table is the actual security boundary).
insert into allowed_emails (email) values ('user@example.com')
on conflict (email) do nothing;

-- Cache of localized florist search keywords + Google Maps language per
-- country, derived by ingest/keywords.py (Claude) and reused across cities
-- and re-runs so the same country isn't re-derived every ingest.
create table country_keywords (
  country     text primary key,
  keywords    jsonb not null,
  language    text,
  updated_at  timestamptz not null default now()
);

alter table country_keywords enable row level security;
-- Same pattern as `allowed_emails`: intentionally NO policies — unreadable/
-- unwritable by anon and authenticated roles. Only the service-role ingest
-- pipeline (which bypasses RLS) reads/writes this cache.

-- Background-job tracking for ingest runs kicked off from the dashboard.
-- `id` is normally supplied by the caller (a UUID minted by the dashboard
-- when it starts a run) — the ingest CLI upserts on that exact id via
-- `--job-id`, so the default below is only a fallback for manual testing.
create table ingest_jobs (
  id                 uuid primary key default gen_random_uuid(),
  country            text not null,
  city               text not null,
  radius_km          double precision,
  limit_per_keyword  integer,
  keywords           jsonb,
  language           text,
  reset_existing     boolean not null default false, -- did this run pass --reset-existing (persisted so the poller can reconstruct it)
  status             text not null,          -- 'queued' | 'running' | 'succeeded' | 'failed'
  last_line          text,                   -- most recent progress line, for a compact status display
  log                text,                   -- bounded tail of progress lines (see ingest/jobs.py)
  error              text,
  started_at         timestamptz not null default now(),
  finished_at        timestamptz,
  input_tokens       bigint,                 -- summed across all real Anthropic calls
  output_tokens      bigint,
  llm_calls          integer,                -- real API calls (cache hits not counted)
  llm_cost_usd       numeric,                -- exact: tokens x per-model rate
  llm_cost_by_type   jsonb,                  -- {type: {calls,input_tokens,output_tokens,cost_usd,model}}
  apify_cost_usd     numeric,                -- actor run's actual usage_total_usd
  florist_count      integer,                -- florists processed this run
  constraint ingest_jobs_status_check check (status in ('queued', 'running', 'succeeded', 'failed'))
);

alter table ingest_jobs enable row level security;
-- Readable by allow-listed dashboard users (like `cities`/`florists`), but
-- with NO insert/update policy: only the service-role ingest CLI writes to
-- this table (bypassing RLS), same write pattern as `country_keywords`.
create policy "allowlisted read ingest_jobs" on ingest_jobs for select to authenticated using (public.is_email_allowed());

-- Outreach CRM (email v1): singleton settings + a per-send audit log. Both
-- readable by allow-listed dashboard users, written only server-side via the
-- service-role client (dashboard/lib/supabaseAdmin.ts) behind auth-gated API
-- routes — same write pattern as `ingest_jobs`/`country_keywords`.
create table app_settings (
  id          integer primary key default 1,
  test_mode   boolean not null default true,   -- SAFE DEFAULT: ON
  test_email  text,
  test_phone  text,                             -- live test-mode SMS sink (all SMS routes here while test_mode is on — see dashboard/lib/offerVars.ts)
  sms_offer_enabled      boolean not null default false,
  sms_recruiting_enabled boolean not null default false,
  updated_at  timestamptz not null default now(),
  constraint app_settings_singleton check (id = 1)
);
insert into app_settings (id) values (1) on conflict (id) do nothing;
alter table app_settings enable row level security;
create policy "allowlisted read app_settings" on app_settings
  for select to authenticated using (public.is_email_allowed());

create table outreach (
  id                  uuid primary key default gen_random_uuid(),
  florist_id          uuid not null references florists(id) on delete cascade,
  channel             text not null default 'email',
  status              text not null,            -- 'sent' | 'failed'
  intended_address    text,                     -- the florist's real email
  to_address          text,                     -- who it ACTUALLY went to (test_email in test mode)
  test_mode           boolean not null,         -- was this a test send
  subject             text,
  body                text,                     -- snapshot of what was sent (post-edit)
  provider_message_id text,                     -- Resend id, null on failure
  error               text,
  sent_by             text,                     -- session user email who triggered it
  sent_at             timestamptz not null default now(),
  constraint outreach_status_check  check (status in ('sent','failed')),
  constraint outreach_channel_check check (channel in ('email','sms'))
);
alter table outreach enable row level security;
create policy "allowlisted read outreach" on outreach
  for select to authenticated using (public.is_email_allowed());

-- Pipeline lifecycle stage constraint + Engagement CRM tables (see
-- supabase/migrations/2026-07-03-pipeline-lifecycle.sql).
alter table florists add constraint florists_lifecycle_stage_check
  check (lifecycle_stage in
    ('found','targeted','contacted','engaged','onboarding','production','lost'));

create table florist_notes (
  id          uuid primary key default gen_random_uuid(),
  florist_id  uuid not null references florists(id) on delete cascade,
  author      text,
  body        text not null,
  created_at  timestamptz not null default now()
);
create index florist_notes_florist_id_idx on florist_notes(florist_id);
alter table florist_notes enable row level security;
create policy "allowlisted read florist_notes" on florist_notes
  for select to authenticated using (public.is_email_allowed());

create table florist_meetings (
  id                uuid primary key default gen_random_uuid(),
  florist_id        uuid not null references florists(id) on delete cascade,
  title             text,
  meeting_at        timestamptz not null,
  outcome           text,
  next_follow_up_at timestamptz,
  created_by        text,
  created_at        timestamptz not null default now()
);
create index florist_meetings_florist_id_idx on florist_meetings(florist_id);
alter table florist_meetings enable row level security;
create policy "allowlisted read florist_meetings" on florist_meetings
  for select to authenticated using (public.is_email_allowed());
