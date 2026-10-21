-- SMS delivery receipts, and the number that can't receive them.
--
-- WHY NOW: we record that a text was handed to Telnyx (`communications`), but
-- nothing has ever recorded whether it ARRIVED. That gap stopped being
-- academic on 2026-08-06: suppressing the offer email for 364 florists whose
-- stored address wasn't their own (see 2026-08-06-florist-networks.sql) makes
-- SMS the primary — often the only — way those shops hear about an order. A
-- channel we can't measure is a bad one to depend on.
--
-- Mirrors supabase/migrations/2026-08-05-email-events.sql deliberately: same
-- shape, same idempotency story, same RLS posture. Two tables rather than one
-- polymorphic events table because the event vocabularies genuinely differ (an
-- SMS is never 'opened'; an email never has a carrier), and a shared table
-- would need a nullable column per channel-specific field.

create table if not exists sms_events (
  id               uuid primary key default gen_random_uuid(),
  communication_id uuid references communications(id) on delete set null,
  -- Telnyx's own per-recipient status vocabulary, kept verbatim rather than
  -- mapped to the email words. 'delivered' is the only success; the two
  -- *_failed values differ in WHERE it died (before vs after the carrier
  -- accepted it), which is exactly what you want when diagnosing.
  event_type       text not null check (event_type in
                      ('queued', 'sending', 'sent', 'delivered',
                       'sending_failed', 'delivery_failed', 'delivery_unconfirmed')),
  -- Telnyx's event id (`data.id`), NOT the message id. Unique so a webhook
  -- retry is a no-op instead of a second row inflating the funnel — the same
  -- role `provider_event_id` plays for Resend (see the email-events
  -- idempotency migration).
  provider_event_id text not null unique,
  -- First error code on the event, when it failed. Stored as its own column
  -- (rather than left in `raw`) because the undeliverable rule below keys off
  -- it, and because staff need to sort by it when a whole region starts
  -- failing.
  error_code       text,
  error_detail     text,
  occurred_at      timestamptz not null default now(),
  raw              jsonb not null
);
create index if not exists sms_events_comm_idx on sms_events(communication_id);
create index if not exists sms_events_occurred_idx on sms_events(occurred_at desc);

comment on table sms_events is
  'One row per Telnyx message.finalized/message.sent webhook, linked back to the communications row it is about. Populated by app/api/webhooks/telnyx/route.ts.';

-- The SMS analogue of florists.email_bounced_at. Set when Telnyx reports a
-- PERMANENT failure for this florist's number; suppresses the SMS leg of later
-- offers (dashboard/lib/offerChannels.ts::smsSkipReason) so we stop texting a
-- number that cannot receive texts.
alter table florists add column if not exists sms_undeliverable_at timestamptz;

comment on column florists.sms_undeliverable_at is
  'When Telnyx last reported a PERMANENT delivery failure for this florist''s number (see app/api/webhooks/telnyx/route.ts for the error codes that count). Non-null skips the offer SMS leg; email + push still fire. Cleared when the number is corrected.';

alter table sms_events enable row level security;

-- Read for allow-listed staff; writes are service-role only from the webhook
-- route (which authenticates by signature, not a staff session). Exactly the
-- email_events posture.
drop policy if exists "allowlisted read sms_events" on sms_events;
create policy "allowlisted read sms_events" on sms_events
  for select to authenticated using (public.is_email_allowed());

-- Statistics: all three florist-facing channels in one payload, for the
-- Messaging section on /statistics.
--
-- Composes `get_email_stats` rather than re-deriving the email half. That
-- function is already deployed and already used by the SQL chat; a second copy
-- of its counting logic here would be free to drift from it, and a funnel that
-- disagrees with itself depending on which page you're on is worse than no
-- funnel. So the email numbers have exactly one definition.
--
-- Two things about the SMS half that make it NOT simply the email shape:
--
--   * It counts DISTINCT communications per stage, not events, so one message
--     Telnyx reports on twice can't read as two deliveries. (get_email_stats
--     counts events — a known wart there, deliberately not copied forward.)
--   * There is no carrier-level 'opened': nothing tells us a text was read.
--     What we DO have is the short link the SMS carries, and a hit on it is a
--     genuine, attributable click. So the SMS funnel's last stage comes from
--     short_links, not from any Telnyx event. `opened` is therefore absent
--     rather than zero — the UI renders it as "—", because reporting 0 opens
--     would read as "nobody read it" when the truth is "we cannot know".
create or replace function get_messaging_stats(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sms_sent integer;
  v_sms_delivered integer;
  v_sms_failed integer;
  v_sms_clicked integer;
  v_push_sent integer;
  v_push_failed integer;
begin
  if not public.is_email_allowed() then
    raise exception 'not authorized';
  end if;

  select
    count(*) filter (where channel = 'sms' and status = 'sent'),
    count(*) filter (where channel = 'push' and status = 'sent'),
    count(*) filter (where channel = 'push' and status = 'failed')
    into v_sms_sent, v_push_sent, v_push_failed
  from communications
  where created_at >= p_from::timestamptz and created_at < (p_to + 1)::timestamptz;

  select
    count(distinct c.id) filter (where e.event_type = 'delivered'),
    count(distinct c.id) filter (where e.event_type in ('delivery_failed', 'sending_failed'))
    into v_sms_delivered, v_sms_failed
  from sms_events e
  join communications c on c.id = e.communication_id
  where c.channel = 'sms'
    and c.created_at >= p_from::timestamptz and c.created_at < (p_to + 1)::timestamptz;

  -- Short links are minted per send, so links created in the window that were
  -- hit give clicks attributable to an SMS. `kind = 'magic'` excludes the
  -- unsubscribe link — an opt-out is not engagement with the offer.
  select count(*) into v_sms_clicked
  from short_links
  where kind = 'magic' and hit_count > 0
    and created_at >= p_from::timestamptz and created_at < (p_to + 1)::timestamptz;

  return jsonb_build_object(
    'email', public.get_email_stats(p_from, p_to),
    'sms', jsonb_build_object(
      'sent', coalesce(v_sms_sent, 0),
      'delivered', coalesce(v_sms_delivered, 0),
      'failed', coalesce(v_sms_failed, 0),
      'clicked', coalesce(v_sms_clicked, 0)
    ),
    'push', jsonb_build_object(
      'sent', coalesce(v_push_sent, 0),
      'failed', coalesce(v_push_failed, 0)
    )
  );
end;
$$;

revoke all on function get_messaging_stats(date, date) from public, anon;
grant execute on function get_messaging_stats(date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- Fix: the email funnel counted EVENTS, not emails.
--
-- Putting email and SMS side by side in one table made a long-standing wart
-- impossible to ignore — the live numbers read "delivered 38, opened 42",
-- which is not a funnel, it's a contradiction. Cause: one email opened three
-- times counted as three opens, while a delivery is reported once. Measured on
-- the live data at the time of writing: 42 open EVENTS across 31 distinct
-- emails, 19 click events across 10 emails.
--
-- Counting distinct communications per stage is what the label "Delivery
-- funnel" has always claimed, and it makes the numbers monotonic on their own
-- rather than needing the UI to paper over them. `bounced` and `complained`
-- are counted the same way for consistency: they are shown as totals, and one
-- address bouncing twice is one bad address, not two.
--
-- Changed here rather than in the ops-stats migration it came from, so the
-- original stays an accurate record of what shipped that day.
create or replace function get_email_stats(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sent integer;
  v_delivered integer;
  v_opened integer;
  v_clicked integer;
  v_bounced integer;
  v_complained integer;
begin
  if not public.is_email_allowed() then
    raise exception 'not authorized';
  end if;

  select count(*) filter (where status = 'sent') into v_sent
  from communications
  where channel = 'email' and created_at >= p_from::timestamptz and created_at < (p_to + 1)::timestamptz;

  select
    count(distinct c.id) filter (where e.event_type = 'delivered'),
    count(distinct c.id) filter (where e.event_type = 'opened'),
    count(distinct c.id) filter (where e.event_type = 'clicked'),
    count(distinct c.id) filter (where e.event_type = 'bounced'),
    count(distinct c.id) filter (where e.event_type = 'complained')
    into v_delivered, v_opened, v_clicked, v_bounced, v_complained
  from email_events e
  join communications c on c.id = e.communication_id
  where c.channel = 'email' and c.created_at >= p_from::timestamptz and c.created_at < (p_to + 1)::timestamptz;

  return jsonb_build_object(
    'sent', coalesce(v_sent, 0),
    'delivered', coalesce(v_delivered, 0),
    'opened', coalesce(v_opened, 0),
    'clicked', coalesce(v_clicked, 0),
    'bounced', coalesce(v_bounced, 0),
    'complained', coalesce(v_complained, 0)
  );
end;
$$;
