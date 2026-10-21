-- Switching off the repeat-florist opening of the offer email.
--
-- `offer.short` is the same offer with a different first line, sent when the
-- shop has accepted something from us recently (lib/offerVars.ts ::
-- hasRecentAcceptedOrder). It appears on /flows as its own row, so it needs
-- its own tick — and the honest meaning of unticking it is "stop varying the
-- opening; send everyone the full one", not "send nothing", because the order
-- still has to be offered.
--
-- Defaults TRUE: this is how offers have behaved since the variant existed,
-- and a migration must not quietly change what a florist reads.
alter table app_settings
  add column if not exists offer_short_variant_enabled boolean not null default true;

comment on column app_settings.offer_short_variant_enabled is
  'false = every offer email uses the full opening, even for a shop that accepted recently. Read in lib/offerVars.ts where the variant is chosen; the offer itself is never suppressed by this.';
