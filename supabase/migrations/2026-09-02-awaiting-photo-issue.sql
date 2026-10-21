-- "You accepted this — are you on it?", as a first-class issue type.
--
-- When a shop accepts an order and then goes quiet — no ready photo, no
-- delivered photo, and the window closing — the desk's first move is to CHASE
-- THEM, not to take the order away. The photo is the simplest possible proof of
-- "yes, I accepted and I am doing it", so that is what we ask for.
--
-- It rides on `order_issues` rather than a new table because that is already
-- the shape of "something about this specific order needs attention, addressed
-- to the florist": it appears in their Messages tab, links to the order, and
-- carries read state and a resolution. The only thing missing was a type that
-- says what this one is.
--
-- `other` would have worked and been free. It is not used because
-- lib/opsStats.ts tallies issues BY TYPE, and burying the most common chase in
-- a bucket shared with everything unclassified would make the one number worth
-- watching — how often do accepted orders stall? — unreadable.

alter table order_issues drop constraint if exists order_issues_type_check;

alter table order_issues add constraint order_issues_type_check check (type in (
  'missing_ingredient','wrong_address','out_of_range',
  'recipient_unavailable','damaged_wrong_recipient','other',
  -- Raised BY US, unlike every type above it, which a florist raises. Kept in
  -- the same set anyway: to the florist it is one list of things needing their
  -- attention on an order, and splitting it by who started the conversation
  -- would be our filing system leaking into their inbox.
  'awaiting_photo'
));

comment on constraint order_issues_type_check on order_issues is
  'Issue types. All florist-raised except awaiting_photo, which CX raises to '
  'chase a shop that accepted and then went quiet.';

-- The approval that produces it.
--
-- A fulfilment breach used to file `reassign`, and approving that MOVED THE
-- ORDER to the next shop. That is not what the desk wants to do first: an
-- accepted order belongs to the florist who accepted it, so the first move is
-- to ask them for a photo, and only then to consider moving it.
--
-- `reassign` stays in the set. It is still the right proposal when a person has
-- decided the shop really is gone, and it is what the approval executor runs.
alter table order_approvals drop constraint if exists order_approvals_kind_check;

alter table order_approvals add constraint order_approvals_kind_check check (kind in (
  'match','offer','reassign','escalate','writeback',
  'client_assigned','client_on_the_way','client_delivered',
  -- Ask the shop that accepted to prove they are on it.
  'chase_photo'
));
