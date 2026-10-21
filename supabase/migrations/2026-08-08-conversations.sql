-- Two-way threads with a florist, and the AI CX persona that answers them.
--
-- Inbound email arrives via Resend Inbound (app/api/webhooks/resend-inbound),
-- inbound SMS via Telnyx (app/api/webhooks/telnyx, the same route that takes
-- delivery receipts — Telnyx posts both to one URL). Both funnel through one
-- ingest path, so there is exactly ONE place where an inbound message becomes a
-- decision.
create table if not exists conversations (
  id                uuid primary key default gen_random_uuid(),
  -- Nullable: a reply can arrive from an address we cannot map to a florist.
  -- That is a real case (a forwarded thread, a personal address), and dropping
  -- it would silently lose an interested shop. It lands as awaiting_human.
  florist_id        uuid references florists(id) on delete set null,
  channel           text not null check (channel in ('email','sms')),
  persona_id        uuid references outreach_personas(id) on delete set null,
  enrolment_id      uuid references sequence_enrolments(id) on delete set null,
  subject           text,
  status            text not null default 'bot'
                      check (status in ('bot','awaiting_human','closed')),
  -- How many replies the AI has sent WITHOUT a human looking. The hard ceiling
  -- on how far off the rails this can go — see the comment on the settings
  -- column below.
  auto_turns        integer not null default 0,
  last_inbound_at   timestamptz,
  last_outbound_at  timestamptz,
  escalated_at      timestamptz,
  escalation_reason text,
  cx_unread         boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists conversations_attention
  on conversations (status, cx_unread, last_inbound_at desc);
create index if not exists conversations_florist
  on conversations (florist_id, created_at desc);

create table if not exists conversation_messages (
  id                  uuid primary key default gen_random_uuid(),
  conversation_id     uuid not null references conversations(id) on delete cascade,
  direction           text not null check (direction in ('in','out')),
  channel             text not null check (channel in ('email','sms')),
  from_address        text,
  to_address          text,
  subject             text,
  body_text           text,
  body_html           text,
  provider            text,
  provider_message_id text,
  -- Idempotency, identical in shape to email_events.provider_event_id: a
  -- provider retry must be a no-op insert, not a second turn fed to the model.
  provider_event_id   text unique,
  communication_id    uuid references communications(id) on delete set null,
  ai_generated        boolean not null default false,
  ai_model            text,
  ai_confidence       numeric,
  ai_intent           text,
  ai_escalate         boolean,
  ai_raw              jsonb,
  status              text not null default 'sent'
                        check (status in ('received','draft','sent','suppressed')),
  suppress_reason     text,
  actor               text,
  created_at          timestamptz not null default now()
);

create index if not exists conversation_messages_thread
  on conversation_messages (conversation_id, created_at);

comment on column conversation_messages.status is
  'draft = the model wrote it and the escalation gate refused to auto-send; a human approves or edits it. suppressed = we deliberately did not answer (a hard opt-out, an auto-responder, a bounce) and the model never saw the message at all.';

comment on column conversation_messages.ai_raw is
  'The full structured response from the model. Kept so an escalation can be audited afterwards — "why did it think that" is unanswerable from a confidence score alone.';

alter table conversations         enable row level security;
alter table conversation_messages enable row level security;

create policy "allowlisted read conversations" on conversations
  for select to authenticated using (public.is_email_allowed());
create policy "allowlisted read conversation_messages" on conversation_messages
  for select to authenticated using (public.is_email_allowed());

alter table app_settings
  -- Ships DARK. Recommended rollout: leave this off and read a week of real
  -- drafts against real replies before letting it send unattended. The cost of
  -- that week is a few CX clicks; the cost of skipping it is a false promise in
  -- writing, in a language nobody on the team reads.
  add column if not exists cx_agent_enabled          boolean not null default false,
  add column if not exists cx_agent_min_confidence   numeric not null default 0.75,
  -- The guard I would actually defend. Regex-based promise detection across six
  -- languages is weak; a hard ceiling of N unattended replies is not. After
  -- this many auto-turns the thread goes to a human regardless of how confident
  -- the model is.
  add column if not exists cx_agent_max_auto_turns   integer not null default 3,
  -- OpenRouter slug, not a bare Anthropic id: the agent goes through
  -- OpenRouter like recruitingPersonalise and statsChat, so one key covers
  -- every text-generating call and a model swap is a settings change.
  add column if not exists cx_agent_model            text not null default 'anthropic/claude-sonnet-5';

comment on column app_settings.cx_agent_max_auto_turns is
  'Hard ceiling on consecutive AI replies with no human involved. This — together with escalating whole INTENT CATEGORIES (pricing, legal, complaint, asked-for-a-human) before the text is even examined — is what actually bounds this feature. The text-matching guards are backstops.';
