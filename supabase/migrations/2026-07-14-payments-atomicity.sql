-- Payment atomicity & correctness hardening.
-- Idempotent (create-if-not-exists / create-or-replace).

-- 1. Race-safe idempotency: at most one non-clawback payout per (assignment, leg).
--    Clawback rows reuse leg='accept' with status 'clawed_back', so they're excluded
--    from the uniqueness constraint. This replaces the app-side count-check (which had
--    a check-then-insert race that could double-issue).
create unique index if not exists payouts_assignment_leg_uidx
  on payouts (assignment_id, leg)
  where status <> 'clawed_back';

-- 2. Atomic finalize: update the payout + write payment_events + order_events in ONE
--    transaction (a plpgsql function body is atomic). Replaces three separate PostgREST
--    writes that could partially fail and leave the ledger inconsistent.
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

  insert into order_events (order_id, type, payload, actor)
    values (p_order_id, 'payout_' || p_leg,
            jsonb_build_object('status', case when p_ok then 'issued' else 'failed' end, 'amount', p_amount),
            'system');
end;
$$;

-- 3. Atomic, idempotent, race-safe clawback. A transaction-scoped advisory lock keyed on
--    the order serializes concurrent clawbacks for the same order; the amount to reclaim
--    is computed net of any PRIOR clawbacks, so calling this twice never double-claws.
--    The recovery is distributed PER ASSIGNMENT (each negative row capped at that
--    assignment's own outstanding paid-minus-clawed), so an order paid to more than one
--    florist (e.g. after a reassignment) reduces the RIGHT florist's balance rather than
--    dumping the whole amount onto an arbitrary one. Returns the total recovered (0 = none).
--    The external card-close side stays in the app layer (an Airwallex call can't live in
--    a DB transaction).
create or replace function clawback_order(
  p_order_id  uuid,
  p_new_total numeric
) returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_paid      numeric := 0;
  v_clawed    numeric := 0;  -- positive magnitude already reclaimed (order-wide)
  v_recover   numeric := 0;  -- total still to reclaim
  v_remaining numeric := 0;
  v_a_clawed  numeric := 0;
  v_a_recover numeric := 0;
  v_payout_id uuid;
  r record;
begin
  -- Serialize clawbacks for this order (released at tx end).
  perform pg_advisory_xact_lock(hashtext(p_order_id::text));

  select coalesce(sum(p.amount), 0) into v_paid
    from payouts p join order_assignments a on a.id = p.assignment_id
   where a.order_id = p_order_id and p.status = 'issued';

  select coalesce(-sum(p.amount), 0) into v_clawed
    from payouts p join order_assignments a on a.id = p.assignment_id
   where a.order_id = p_order_id and p.status = 'clawed_back';

  if p_new_total is null then
    v_recover := v_paid - v_clawed;                       -- full cancel: reclaim all not-yet-clawed
  else
    v_recover := greatest(0, (v_paid - p_new_total) - v_clawed);
  end if;

  v_recover := round(v_recover, 2);
  if v_recover <= 0 then
    return 0;
  end if;

  -- Distribute across the order's paid assignments, largest paid-out first, capping each
  -- at its own outstanding (never claw an assignment more than it was actually paid).
  v_remaining := v_recover;
  for r in
    select p.assignment_id as assignment_id,
           coalesce(sum(p.amount), 0) as a_paid,
           max(p.currency) as currency
      from payouts p join order_assignments a on a.id = p.assignment_id
     where a.order_id = p_order_id and p.status = 'issued'
     group by p.assignment_id
     order by a_paid desc
  loop
    exit when v_remaining <= 0;
    select coalesce(-sum(amount), 0) into v_a_clawed
      from payouts where assignment_id = r.assignment_id and status = 'clawed_back';
    v_a_recover := round(least(v_remaining, r.a_paid - v_a_clawed), 2);
    if v_a_recover <= 0 then
      continue;
    end if;
    insert into payouts (assignment_id, leg, amount, currency, status)
      values (r.assignment_id, 'accept', -v_a_recover, coalesce(r.currency, 'EUR'), 'clawed_back')
      returning id into v_payout_id;
    insert into payment_events (payout_id, type, payload)
      values (v_payout_id, 'clawed_back', jsonb_build_object('orderId', p_order_id, 'assignmentId', r.assignment_id, 'recovered', v_a_recover, 'newTotal', p_new_total));
    v_remaining := round(v_remaining - v_a_recover, 2);
  end loop;

  insert into order_events (order_id, type, payload, actor)
    values (p_order_id, 'payout_clawback', jsonb_build_object('recovered', round(v_recover - v_remaining, 2), 'newTotal', p_new_total), 'system');

  return round(v_recover - v_remaining, 2);
end;
$$;
