-- Why was this offer held for a human?
--
-- When the wave engine refuses to send a cold offer unattended it files an
-- `order_approvals` row instead. Until now that row carried the draft email and
-- nothing else: `coldOfferBlockReason()` works out precisely which gate refused
-- — too urgent, payout over the ceiling, no email, opted out, no coordinates —
-- and `coldOfferAllowed()` then collapsed the answer to a boolean and threw it
-- away.
--
-- The cost was not academic. The daily digest can say "3 orders never got an
-- offer, a person has to send them" and cannot say WHY, so nobody can tell
-- whether raising the payout ceiling, shortening the minimum lead time, or
-- chasing missing email addresses would move the number. Measured on Palma:
-- 62 of 94 live shops fail on `no-email` and none fail on the ceiling or the
-- lead time — so raising the ceiling would have changed nothing, and there was
-- no way to know that from the product.
--
-- Deliberately `text` and NOT a check constraint or an enum. The set of reasons
-- will grow (a malformed address is being added in the same change as
-- `bad-email`), and some future reason will be one nobody predicted. A column
-- that rejects an unrecognised value would turn "we learned something new about
-- why offers stall" into a failed insert on the path that files CX work — the
-- worst possible place to be strict. Readers must treat an unknown value as
-- "some other reason" and show it verbatim.

alter table order_approvals
  add column if not exists block_reason text;

comment on column order_approvals.block_reason is
  'Why this step needed a human, when the system knows: a coldOfferBlockReason() '
  'value (too-urgent, payout-too-high, no-email, bad-email, opted-out, '
  'no-location, excluded, lost, already-joined, disabled, payout-unknown), '
  '"semi-mode" when the step gate is what stopped it, "lookup-failed" when the '
  'eligibility check itself errored, or null when it does not apply. Free text '
  'on purpose — new reasons must never fail the insert.';

-- Answering "which gate is costing us the most offers this week" is the whole
-- point, and it is a filtered scan over pending/recent approvals.
create index if not exists order_approvals_block_reason_idx
  on order_approvals (block_reason)
  where block_reason is not null;
