-- Order-aware support conversations: the florist app gains a chat, and inbound
-- email gains an order.
--
-- This EXTENDS the recruiting conversation machinery (2026-08-08-conversations)
-- rather than forking it. One table, one ingest path, one escalation gate; the
-- new `kind` column selects which persona, which prompt and — the load-bearing
-- part — which set of facts the agent is allowed to state.
--
--   kind='recruiting'  a shop we are trying to sign. Facts = the join pitch
--                      (lib/cxAgent.ts::APPROVED_FACTS). Unchanged by this
--                      migration in every respect.
--   kind='support'     a shop already in the network asking about THEIR order
--                      or THEIR money. Facts are computed per conversation by
--                      lib/supportFacts.ts from live rows.
--
-- The two are mutually exclusive by construction: the recruiting agent only
-- answers a florist with no joined_at (lib/conversations.ts, `eligible`), and
-- the support agent only answers one that has it.

-- 1. conversations: what order is this about, and which agent owns it ---------

alter table conversations
  add column if not exists order_id      uuid references orders(id) on delete set null,
  -- Denormalized, no FK, matching communications.assignment_id: the thread must
  -- survive a reassignment that deletes the assignment row it started on.
  add column if not exists assignment_id uuid,
  add column if not exists kind          text not null default 'recruiting',
  -- Mirrors cx_unread on the other side of the glass. Drives the badge on the
  -- florist's Messages tab, which otherwise counts only order_issues +
  -- florist_messages and would silently omit a reply the florist is waiting on.
  add column if not exists florist_unread boolean not null default false;

alter table conversations
  drop constraint if exists conversations_kind_check;
alter table conversations
  add constraint conversations_kind_check check (kind in ('recruiting','support'));

-- 'app' = written from inside the florist app, not carried by a provider. The
-- constraint is dropped and re-added because the original was declared inline
-- and there is no other way to widen a CHECK.
alter table conversations
  drop constraint if exists conversations_channel_check;
alter table conversations
  add constraint conversations_channel_check check (channel in ('email','sms','app'));

alter table conversation_messages
  drop constraint if exists conversation_messages_channel_check;
alter table conversation_messages
  add constraint conversation_messages_channel_check check (channel in ('email','sms','app'));

-- One live support thread per florist per order. Without this, a florist who
-- asks in the app and then replies to the same order's email ends up talking to
-- two threads that cannot see each other's history — which is precisely the
-- failure the order matching exists to prevent.
create unique index if not exists conversations_one_live_support
  on conversations (florist_id, order_id)
  where kind = 'support' and status <> 'closed';

create index if not exists conversations_order
  on conversations (order_id, created_at desc);

comment on column conversations.kind is
  'recruiting = a prospect being signed; the agent may state only lib/cxAgent.ts::APPROVED_FACTS. support = a joined florist asking about their own order; the agent may state only the facts lib/supportFacts.ts computed for THIS conversation, enforced by lib/cxAgentGuard.ts::moneyClaimOutsideFacts. Adding a kind means adding a fact set — an agent with no allowed facts can say nothing at all, which is the correct failure direction.';

comment on column conversations.order_id is
  'Set by lib/inboundMatch.ts (reply-address token, then In-Reply-To threading) or directly when the thread is opened from an order in the florist app. NEVER inferred from subject or body text: attaching one florist''s message to another order is worse than leaving it unattached, so an unmatched inbound lands here as null and goes to a human.';

-- 2. communications: our own Message-ID, so replies can be threaded -----------

-- Not provider_message_id. That column holds Resend's opaque id, and I have not
-- verified it equals the RFC 5322 Message-ID a mail client echoes back in
-- In-Reply-To. We set our own header at send time and store it here, so the
-- threading leg depends on nothing we cannot see.
alter table communications
  add column if not exists rfc_message_id text;

create unique index if not exists communications_rfc_message_id
  on communications (rfc_message_id)
  where rfc_message_id is not null;

comment on column communications.rfc_message_id is
  'The RFC 5322 Message-ID header we set on an outbound email, e.g. <fc.<uuid>@mail.fc.example.com>. Read back by lib/inboundMatch.ts from a reply''s In-Reply-To/References to recover order_id + florist_id. Distinct from provider_message_id, which is Resend''s own opaque id.';

-- 3. Settings: the support agent ships dark, separately from recruiting -------

alter table app_settings
  -- Its own switch, not a reuse of cx_agent_enabled. The two agents talk to
  -- different people about different things and carry different risk: one can
  -- overstate an offer, the other can misstate what we owe a business. Being
  -- able to run either without the other is the point.
  add column if not exists support_agent_enabled boolean not null default false;

comment on column app_settings.support_agent_enabled is
  'Whether the order-aware support agent may answer a joined florist unattended. Ships false. cx_agent_min_confidence / cx_agent_max_auto_turns / cx_agent_model are shared with the recruiting agent deliberately — they are properties of how much we trust an unattended model, not of who it is writing to.';

-- 4. RLS: the florist reads their own thread, and never a draft --------------

-- Staff read policies already exist from 2026-08-08. These add the florist
-- side, scoped by public.current_florist_id() exactly like order_issues and
-- florist_messages.
create policy "florist reads own conversations" on conversations
  for select to authenticated
  using (florist_id = public.current_florist_id());

-- The status filter is the load-bearing half. A 'draft' row is text the model
-- wrote that the escalation gate REFUSED to send — showing it to the florist
-- would deliver, through the back door, exactly the message a guard decided was
-- not safe to deliver. 'suppressed' is the same argument for opt-outs and
-- auto-replies we deliberately never answered.
create policy "florist reads own conversation_messages" on conversation_messages
  for select to authenticated
  using (
    status in ('received','sent')
    and conversation_id in (
      select id from conversations where florist_id = public.current_florist_id()
    )
  );

-- NOTE on columns: RLS is row-level, so these policies cannot hide ai_raw,
-- ai_confidence or ai_intent on a row the florist may legitimately read. The
-- florist app therefore selects an explicit column list server-side
-- (lib/supportThread.ts) and never `select *`. Row-level draft exclusion above
-- is the guarantee; the column list is hygiene on top of it.

-- No write policy on either table, for anyone. Every write goes through a route
-- holding the service-role client — same as order_issues and florist_messages.
