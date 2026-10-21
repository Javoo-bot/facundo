-- Florist join-form redesign: two columns the public join form now captures.
-- See docs/superpowers/specs/2026-08-05-florist-join-form-redesign-design.md.

-- The number we text about orders, confirmed by the florist rather than scraped.
--
-- WHY a new column instead of reusing phone_web: the accept form already wrote
-- its single "Phone" field into phone_web, which is also what
-- lib/phone.ts::resolveFloristSmsPhone texts — so the form was doubling as SMS
-- capture silently, with no validation and no way for staff to tell a confirmed
-- mobile from a shop landline the scraper happened to find. Splitting them makes
-- the intent explicit on both sides. Stored normalised to E.164, so
-- resolveFloristSmsPhone is a passthrough for it.
alter table florists add column if not exists phone_mobile text;

comment on column florists.phone_mobile is
  'Florist-confirmed mobile for order alerts, normalised to E.164 at write time by the join form (dashboard/app/api/florist/accept). Preferred over phone_web and phone_maps by lib/phone.ts::resolveFloristSmsPhone. Null for every florist who has not self-registered.';

-- The florist's own words about their shop, from the join form's free-text box.
--
-- WHY not shop_highlight: that column holds an LLM-researched detail used to
-- personalise recruiting drafts (lib/draftEmail.ts). Different provenance,
-- different trust, different lifetime — and overwriting a researched fact with
-- florist-entered marketing copy would quietly destroy it. Per the repo rule
-- that enrichment fields stay honest about where they came from, these are two
-- columns.
alter table florists add column if not exists shop_story text;

comment on column florists.shop_story is
  'Free text the florist wrote about their own shop on the join form (600 char cap, enforced in lib/floristAccept.ts). Distinct from shop_highlight, which is LLM-researched by the ingest pipeline.';
