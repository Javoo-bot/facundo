-- Florist replies on /communications.
--
-- `communications` logged OUTBOUND messages only (status sent/failed/skipped).
-- A florist's reply was stored in conversation_messages alone, so the panel an
-- operator uses to answer "did the florist write back?" never showed it. On
-- order #2000034 a florist replied with a question before his offer expired and
-- nobody saw it for five days.
--
-- lib/conversations.ts::ingestInbound now also logs each inbound reply here with
-- status 'received' (sender in `actor`). This widens the status check to allow
-- it. Additive: every existing row still satisfies the new constraint.
--
-- Safe to re-run.
alter table communications drop constraint if exists communications_status_check;
alter table communications add constraint communications_status_check
  check (status in ('sent', 'failed', 'skipped', 'received'));

comment on column communications.status is
  'sent | failed | skipped for outbound messages; received for an inbound reply from a florist (logged by lib/conversations.ts::ingestInbound, sender address in actor).';
