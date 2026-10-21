-- Test shops: a florist we own and use to exercise the real order loop.
--
-- WHY: app_settings.test_mode redirects every florist email to the shared staff
-- test inbox AND substitutes inert placeholder tokens for the magic link and the
-- unsubscribe link (see dashboard/lib/offerVars.ts). That is deliberate — a
-- magic link is a LOGIN to a real shop, and test mail lands in an inbox several
-- staff can read. The cost is that the florist experience can never be driven
-- end to end: you cannot click the link you were sent.
--
-- `is_test_shop` marks a florist we control. For those, and ONLY those, test
-- mode stops redirecting and stops substituting: real address, real tokens.
-- Every unflagged florist keeps exactly the old behaviour, so a mis-click can
-- never send a real shop's login into a shared inbox.
alter table florists add column if not exists is_test_shop boolean not null default false;

comment on column florists.is_test_shop is
  'A florist WE own, used to exercise the real order loop. While app_settings.test_mode is on, these receive real email/SMS at their real address with working magic links; every other florist gets the test inbox and inert placeholder tokens. Also governs automatic matching via app_settings.test_shop_matching.';

-- How automatic matching treats test shops (dashboard/lib/match.ts and
-- ingest-worker/src/match.ts::passesHardFilter, kept in lockstep):
--   'exclude' — drop test shops, so a paying customer's order can never be
--               routed to one. The safe default.
--   'only'    — drop everyone else, so the whole loop can be exercised against
--               a shop we own. NOTE: orders outside a test shop's delivery
--               radius then match nothing and escalate to CX, so this is a
--               deliberate, visibly-flagged testing mode, not a resting state.
alter table app_settings add column if not exists test_shop_matching text not null default 'exclude';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'app_settings_test_shop_matching_check'
  ) then
    alter table app_settings
      add constraint app_settings_test_shop_matching_check
      check (test_shop_matching in ('exclude', 'only'));
  end if;
end $$;

comment on column app_settings.test_shop_matching is
  'How automatic matching treats florists.is_test_shop: ''exclude'' (default, test shops never receive real orders) or ''only'' (matching routes exclusively to test shops — a testing mode that strands non-test orders in CX).';

-- Partial index: the 'only' matching mode filters on this flag, and test shops
-- are a handful of rows out of thousands.
create index if not exists florists_is_test_shop_idx on florists (is_test_shop) where is_test_shop;
