-- COLD OFFER: a real, live order offered to a discovered shop that has never
-- joined the network. The email carries a genuine order; the CTA is the normal
-- magic link; accepting it both takes the order AND joins them.
--
-- WHY a new column rather than reusing `offer_kind`: offer_kind is
-- ('exclusive','race') and describes EXCLUSIVITY — whether this offer is the
-- only one out. Audience is orthogonal (a cold offer can be exclusive or raced),
-- and overloading one column with two meanings is how the next reader gets it
-- wrong.
alter table order_assignments
  add column if not exists offer_audience text not null default 'network'
    check (offer_audience in ('network','cold'));

comment on column order_assignments.offer_audience is
  'cold = this shop has never joined. lib/coldOffer.ts::coldOfferEligible gates whether we may send one at all; lib/waves.ts treats it as the explicit exception to "auto never auto-offers a non-onboarded florist"; app/api/florist/respond mints a provisional activation on accept instead of demanding one up front.';

-- Provisional activation, minted at ACCEPT time and never before.
alter table florists
  add column if not exists provisional_activated_at timestamptz,
  add column if not exists provisional_source text;

comment on column florists.provisional_activated_at is
  'Set by lib/coldOffer.ts::buildProvisionalActivation when a cold-offer shop accepts. It fills in delivery_radius_km and trust_tier — exactly the two things lib/floristActivation.ts::computeActivation and ingest-worker/src/match.ts::passesHardFilter demand. Note the distinction: the activation gate is NOT bypassed, its inputs are supplied. No new code path can offer to a shop that fails the filter.';

-- The provisional tier.
--
-- WHY not just use tier 2 ("Known", the default 6,478 florists sit on): tier 2
-- carries a EUR 500 exposure cap, which is a sensible bound for a shop we have
-- vetted and a large one for a shop we found on a map ten minutes ago. Tier 5
-- keeps the 70/30 split the recruiting copy promises — so the florist's
-- experience is identical — while bounding a single fraud to one small order.
--
-- WHY not tier 3 ("New", 0/100): it would be safer still and it would make the
-- copy a lie. "We pay 70% before you buy a stem" is the entire pitch; a shop
-- that accepts on that basis and is then told it gets nothing until delivery
-- has been misled, and would be right to say so.
alter table trust_tiers drop constraint if exists trust_tiers_code_check;
alter table trust_tiers add constraint trust_tiers_code_check
  check (code in ('1','2','3','4','5'));
alter table florists drop constraint if exists florists_trust_tier_check;
alter table florists add constraint florists_trust_tier_check
  check (trust_tier in ('1','2','3','4','5'));

insert into trust_tiers (code, label, split_on_accept, split_on_delivery, photo_required, hold_payout, exposure_cap_eur)
values ('5','Provisional', 70, 30, true, false, 150)
on conflict (code) do nothing;

alter table app_settings
  -- Ships DARK. Turning this on is the decision to put real money on a card for
  -- a shop nobody has checked; it should be a deliberate act, per city.
  add column if not exists cold_offer_enabled            boolean not null default false,
  -- Eligibility: never cold-offer the expensive order. Costs nothing and
  -- removes the entire tail of the loss distribution.
  add column if not exists cold_offer_max_payout_eur     numeric not null default 120,
  -- Above this, the 70% accept leg is HELD for CX release instead of issued
  -- instantly. Below it, instant — which is what the copy promised.
  add column if not exists cold_offer_auto_payout_cap_eur numeric not null default 90,
  add column if not exists cold_offer_default_radius_km  numeric not null default 12;

comment on column app_settings.cold_offer_enabled is
  'Master switch for offering real orders to shops outside the network. FALSE by default. Even when on, lib/waves.ts only auto-sends a cold offer in workflow_mode=auto; in semi it still files an order_approvals row, which is where cold offers should live until the numbers are trusted.';

comment on column app_settings.cold_offer_max_payout_eur is
  'A cold offer is only eligible below this payout. The single cheapest risk control here: it bounds the worst case before any other machinery is involved.';

comment on column app_settings.cold_offer_auto_payout_cap_eur is
  'Above this, a provisional shop''s 70% accept leg is parked as payouts.status=''held'' (which already surfaces on /cx as "approve release") rather than issued unattended. The honest compromise between "70% up front" and "we have never met you".';
