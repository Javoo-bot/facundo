-- Whether the florist support chat widget (OrderChat, on a florist's own order
-- page) shows up at all. Deliberately separate from support_agent_enabled:
-- that one only decides whether the AI answers unattended — off, every
-- question still reaches the chat and lands with a colleague. This flag
-- decides whether the florist sees a chat entry point in the first place.
--
-- Ships true: the widget already renders unconditionally today, so this
-- default keeps that behavior unchanged until someone turns it off.
alter table app_settings
  add column if not exists florist_chat_enabled boolean not null default true;

comment on column app_settings.florist_chat_enabled is
  'Whether the florist support chat (OrderChat) renders on an order page at all. Off hides the launcher and panel entirely. Independent of support_agent_enabled, which only gates the AI auto-reply once the chat is open.';
