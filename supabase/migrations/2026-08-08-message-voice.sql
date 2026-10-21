-- Per-message-kind email VOICE.
--
--   'branded' = today's lib/emailTemplate.ts shell: logo, page background,
--               white card, green CTA button. "A company sent this."
--   'plain'   = looks like a CX rep typed it in their mail client: no logo, no
--               card, no button, a plain signature and one legal footer line.
--
-- WHY it exists: the outreach funnel's first email is from Facundo and every
-- follow-up is from a named person (outreach_personas). A branded template over
-- a personal signature is a contradiction the recipient reads instantly, so the
-- voice has to be settable per message rather than fixed per product.
--
-- WHY one jsonb column rather than a boolean per kind: the kind list grows with
-- every sequence step (seven already, before the cold-offer and persona-reply
-- kinds), and app/api/settings/route.ts is a FULL-FORM OVERWRITE — an omitted
-- field is written back as its default. Twelve more columns would be twelve
-- more ways for one stale client to silently reset a deliberate choice.
--
-- Read via dashboard/lib/messageVoice.ts::voiceForKind, which fails to
-- 'branded' on a missing key or an unparseable value — the behaviour every
-- existing send already has. The plain voice is only ever an explicit choice.
alter table app_settings
  add column if not exists message_voice jsonb not null default '{}'::jsonb;

comment on column app_settings.message_voice is
  'kind -> "branded"|"plain". Keys are the same `kind` strings lib/communications.ts logs (offer, recruit.t1 … recruit.co2, persona_reply). Missing key or unrecognised value resolves to "branded" (lib/messageVoice.ts::voiceForKind, fail-open). A per-sequence-step override lives in lib/sequences/definitions.ts and WINS over this map — see resolveVoice.';
