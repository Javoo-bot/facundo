-- VOICE: local Telnyx numbers + an ElevenLabs agent that answers on them.
--
-- SCHEMA AND SEAMS ONLY. No provider integration lands in this pass — that was
-- a deliberate scoping decision, and this migration exists so the later build
-- is a wiring job rather than a redesign, and so `outreach_personas.phone_e164`
-- has something real to point at.
--
-- Verified provider contract (do not re-derive it later): ElevenLabs Agents
-- connects to Telnyx over SIP TRUNKING — a Telnyx SIP connection of type FQDN
-- pointed at `sip.rtc.elevenlabs.io` — and ONE trunk carries both inbound and
-- outbound. Inbound: a local DID routes into the trunk and the agent answers.
-- Outbound: the agent places calls over the same trunk, from the DID that
-- matches the florist's city.

create table if not exists phone_numbers (
  id                    uuid primary key default gen_random_uuid(),
  e164                  text not null unique,
  country               text not null,
  -- The city this number is "local to". Both directions read this one mapping:
  -- inbound to pick which persona answers, outbound to pick what the florist
  -- sees ring. A number with no city is bought but unassigned.
  city_id               uuid references cities(id) on delete set null,
  persona_id            uuid references outreach_personas(id) on delete set null,
  telnyx_number_id      text,
  telnyx_connection_id  text,
  monthly_cost_eur      numeric,
  status                text not null default 'available'
                          check (status in ('available','assigned','releasing','released')),
  purchased_at          timestamptz not null default now(),
  released_at           timestamptz
);

-- One active number per city. A florist who is called from two different
-- "local" numbers on two different days has been shown the trick.
create unique index if not exists phone_numbers_one_per_city
  on phone_numbers (city_id) where status = 'assigned' and city_id is not null;

comment on table phone_numbers is
  'Telnyx DID inventory. DEFERRED: created so the seams are real, unused until the voice phase. The city -> number mapping here is the single lookup both call directions read.';

create table if not exists voice_calls (
  id                      uuid primary key default gen_random_uuid(),
  florist_id              uuid references florists(id) on delete set null,
  phone_number_id         uuid references phone_numbers(id) on delete set null,
  direction               text not null check (direction in ('in','out')),
  from_e164               text,
  to_e164                 text,
  telnyx_call_control_id  text unique,
  elevenlabs_agent_id     text,
  elevenlabs_conversation_id text,
  status                  text,
  duration_seconds        integer,
  transcript              jsonb,
  summary                 text,
  outcome                 text,
  -- NOT NULL and defaulted true on purpose. The agent must open by saying it is
  -- automated and offering a human; recording whether that actually happened is
  -- the difference between a policy and a claim. An undisclosed AI voice call to
  -- an EU business is the case regulators actually pursue, and "we told it to"
  -- is not evidence.
  disclosure_played       boolean not null default true,
  started_at              timestamptz,
  ended_at                timestamptz,
  created_at              timestamptz not null default now()
);

create index if not exists voice_calls_florist on voice_calls (florist_id, created_at desc);

comment on column voice_calls.disclosure_played is
  'Whether the agent actually played the "this is an automated assistant, I can put you through to a person" opener. Recorded per call, not assumed from configuration.';

alter table phone_numbers enable row level security;
alter table voice_calls   enable row level security;

create policy "allowlisted read phone_numbers" on phone_numbers
  for select to authenticated using (public.is_email_allowed());
create policy "allowlisted read voice_calls" on voice_calls
  for select to authenticated using (public.is_email_allowed());
