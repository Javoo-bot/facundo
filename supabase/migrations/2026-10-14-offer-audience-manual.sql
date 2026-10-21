-- A shop staff attach to an order by hand (POST /api/orders/assign, which
-- bypasses the onboarded filter) is activated on accept the same way a
-- cold-offer shop is (the owner, 2026-10-14). The assign route stamps
-- offer_audience='manual' when the shop has not joined; both accept routes
-- then mint through lib/coldOfferActivate.ts::mintProvisionalActivation with
-- provisional_source='manual_assign'.
--
-- WHY not reuse 'cold': lib/sequences/reconcile.ts::enrolLapsedColdOffers
-- emails every lapsed 'cold' assignment "the order you were offered went
-- elsewhere". A manual candidate can lapse without ever having been sent.
--
-- Safe in either order with the code: the route stamps in a separate write
-- and only logs if this constraint still refuses 'manual'.
alter table order_assignments drop constraint if exists order_assignments_offer_audience_check;
alter table order_assignments add constraint order_assignments_offer_audience_check
  check (offer_audience in ('network','cold','manual'));

comment on column order_assignments.offer_audience is
  'cold = the wave engine auto-offered a shop that has never joined (lib/coldOffer.ts::coldOfferEligible gates it). manual = staff attached a shop that has never joined via app/api/orders/assign. Both mint a provisional activation on accept (lib/coldOffer.ts::provisionalSourceOnAccept). Only cold feeds the lapsed-offer follow-up.';
