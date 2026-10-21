-- Widen `payouts` so a manual (order-less) leg can exist alongside the
-- existing accept/delivery legs — see docs/superpowers/specs/2026-07-30-admin-card-issuance-design.md.

alter table payouts alter column assignment_id drop not null;
alter table payouts add column if not exists florist_id uuid references florists(id);

alter table payouts drop constraint if exists payouts_leg_check;
alter table payouts add constraint payouts_leg_check
  check (leg in ('accept', 'delivery', 'manual'));

alter table payouts drop constraint if exists payouts_leg_shape_check;
alter table payouts add constraint payouts_leg_shape_check
  check (
    (leg = 'manual' and assignment_id is null and florist_id is not null)
    or
    (leg in ('accept', 'delivery') and assignment_id is not null and florist_id is null)
  );

-- finalize_payout: p_order_id becomes optional — a manual payout has no order to
-- log against, so skip the order_events insert when it's null. Signature is
-- unchanged (uuid params are already nullable), so this is a pure body edit;
-- existing order-driven callers always pass a real order_id and are unaffected.
create or replace function finalize_payout(
  p_payout_id     uuid,
  p_ok            boolean,
  p_provider_ref  text,
  p_event_payload jsonb,
  p_order_id      uuid,
  p_leg           text,
  p_amount        numeric
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update payouts
     set status       = case when p_ok then 'issued' else 'failed' end,
         provider_ref = case when p_ok then p_provider_ref else null end,
         updated_at   = now()
   where id = p_payout_id;

  insert into payment_events (payout_id, type, payload)
    values (p_payout_id, case when p_ok then 'issued' else 'failed' end, coalesce(p_event_payload, '{}'::jsonb));

  if p_order_id is not null then
    insert into order_events (order_id, type, payload, actor)
      values (p_order_id, 'payout_' || p_leg,
              jsonb_build_object('status', case when p_ok then 'issued' else 'failed' end, 'amount', p_amount),
              'system');
  end if;
end;
$$;
