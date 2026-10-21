-- Align the default florist payout split with the approved pilot policy.
--
-- Product decision (2026-08-13): every florist should receive 70% when they
-- accept an order and the remaining 30% after uploading the ready-bouquet photo.
--
-- Tier 2 remains the default "Known" tier for newly-ingested florists (it still
-- carries its €500 exposure cap and photo_required=true), but its split now
-- matches the public recruiting/order copy and the approved payment policy.

update trust_tiers
set split_on_accept = 70,
    split_on_delivery = 30,
    photo_required = true,
    updated_at = now()
where code = '2';

alter table florists alter column trust_tier set default '2';
