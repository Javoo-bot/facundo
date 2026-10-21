-- Accepting an order and uploading a delivered photo are self-approving.
--
-- Until now the workflow mode gated payouts: `semi` held BOTH legs, and any
-- non-`auto` mode held the delivery leg. On the live account (workflow_mode =
-- 'semi', payments_live = true) that meant every single payout queued behind a
-- human, including the 70% a florist is owed the moment they accept — which is
-- the one promise the recruiting copy makes explicitly.
--
-- Workflow mode still gates system-initiated steps (who we offer to, what we
-- write back to Shopify). It no longer gates paying a florist who has done the
-- work. The rule now lives in dashboard/lib/payoutHold.ts, where it is unit
-- tested; what remains able to hold a leg is a substantive finding — an
-- untrusted trust tier, an unvetted provisional cold-offer shop above the auto
-- cap, or an AI photo check that came back `review`/`fail`.
--
-- `hold_delivery_payouts` survives as the operator's manual override, but its
-- resting state flips: it was `true` waiting for the AI photo check to ship,
-- and that check has shipped (photo_verify_claude / _gemini / _openrouter).
-- Leaving it `true` would mean this migration changes nothing for the 30% leg.

alter table app_settings
  alter column hold_delivery_payouts set default false;

comment on column app_settings.hold_delivery_payouts is
  'Operator override: put the 30% delivery leg back in the CX approval queue by hand. Default false — a delivered photo releases the 30%, and the AI photo check (dashboard/lib/payoutHold.ts) holds it only on a review/fail verdict. Not read for the 70% accept leg.';

-- Flip the existing singleton row too. A default only applies to new rows, and
-- there is exactly one settings row (id = 1) — without this the running system
-- keeps holding every delivery leg and the change is inert.
update app_settings set hold_delivery_payouts = false where id = 1;
