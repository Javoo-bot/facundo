-- Unpublished edits for the message editor (dashboard/app/(staff)/messages).
--
-- Deliberately a SEPARATE table from message_overrides rather than a status
-- column on it. message_overrides is what every send site reads; leaving it
-- untouched means the send path cannot be affected by a half-finished edit,
-- and no send-site query needs a new `where status = 'published'` clause that
-- someone could forget.
--
-- Publish copies rows across and clears them here. Discard deletes them.
create table if not exists message_override_drafts (
  locale     text not null,
  key        text not null,
  value      text not null,
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (locale, key)
);

comment on table message_override_drafts is
  'Unpublished message copy edits. Sends read message_overrides only; a row here has no effect until published.';

alter table message_override_drafts enable row level security;

-- No policy for `authenticated`: the editor reaches this only through
-- service-role routes that already gate on staff role (ops/admin), exactly as
-- message_overrides does. RLS on with no policy = deny for anon/authenticated,
-- which is the intended posture for a table that decides what real florists
-- and customers receive.
