-- The named human persona every outreach follow-up comes from.
-- See docs/superpowers/specs/2026-08-08-florist-communications-design.md.
--
-- WHY this exists: the cold-outreach funnel's rule is that touch 1 comes from
-- the company and every follow-up comes from ONE named person, consistently,
-- across every channel. A prospect who gets three emails from "Facundo" has
-- been marketed at; a prospect who gets one from Facundo and two from the
-- same named onboarding manager has been talked to. That difference is the
-- whole point of the funnel, and it needs a place to live.
--
-- WHY per-locale rather than one global persona: a shop in Girona reading
-- fluent Spanish signed "Marta Ruiz" reads as local. The same shop reading
-- fluent Spanish signed by a name that also signs the German and Italian
-- versions reads as a mail-merge the moment anyone compares notes. One active
-- persona per locale, resolved at send time by lib/personas.ts::resolvePersona.
--
-- WHY the reply_to column is NOT NULL: the persona is only honest if replying
-- to it reaches something. Every persona address is a real inbox on the Resend
-- inbound domain (app/api/webhooks/resend-inbound), read by the AI CX agent and
-- escalated to a human on anything it should not answer alone. A persona
-- without a working reply address would be a signature on a dead end.
create table if not exists outreach_personas (
  id             uuid primary key default gen_random_uuid(),
  locale         text not null,
  name           text not null,
  role_title     text not null,
  photo_url      text,
  reply_to       text not null,
  -- Null until the voice phase buys a local number for this market
  -- (supabase/migrations/2026-08-08-voice-numbers.sql, phone_numbers.persona_id).
  phone_e164     text,
  signature_note text,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- At most one ACTIVE persona per locale. Partial (not plain) so a retired
-- persona's rows stay for the audit trail — conversation_messages and
-- voice_calls reference the persona that actually sent each message, and
-- rewriting history to the current persona would misattribute old threads.
create unique index if not exists outreach_personas_one_active_per_locale
  on outreach_personas(locale) where active;

comment on table outreach_personas is
  'The named human persona that signs every outreach follow-up, one active row per locale. Read at send time by lib/personas.ts::resolvePersona (pure; falls back to the EN persona so a market without one never renders a blank signature) and by lib/sequences/tick.ts for any step whose `from` is "persona".';

comment on column outreach_personas.reply_to is
  'A REAL inbox on the Resend inbound domain — replies land in app/api/webhooks/resend-inbound and are answered by lib/cxAgent.ts or escalated to a human. Not decorative: a persona signature over a non-existent address turns every interested reply into a bounce.';

comment on column outreach_personas.phone_e164 is
  'The local number this persona answers on. Null until the deferred voice phase; when set it matches a phone_numbers row and is what the ElevenLabs agent answers as.';

alter table outreach_personas enable row level security;

-- Staff (allow-listed) read it to render the Settings → Personas panel; writes
-- go through the service-role client in app/api/settings/personas, same shape
-- as every other staff-managed table here.
create policy "allowlisted read outreach_personas" on outreach_personas
  for select to authenticated
  using (public.is_email_allowed());
