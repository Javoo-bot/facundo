-- Runtime DB-override layer for the email-string catalog
-- (dashboard/lib/i18n/messages/*.ts). The static TS files stay the built-in
-- defaults for every (locale, key); a row here overrides one leaf at runtime,
-- with no deploy. Composite PK: one override per (locale, key), upsert to
-- edit, delete to revert to the static default.
--
-- Reads: allow-listed staff only (same is_email_allowed() policy every other
-- staff-read table uses — see supabase/schema.sql).
-- Writes: service-role only — no insert/update/delete policy, matching
-- app_settings/allowed_emails. The editor UI writes through
-- dashboard/app/api/settings/message-overrides/route.ts, which is
-- requireRole("admin")-gated and uses the service client.
create table if not exists message_overrides (
  locale text not null,
  key text not null,
  value text not null,
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (locale, key)
);

alter table message_overrides enable row level security;

create policy "allowlisted read message_overrides" on message_overrides
  for select to authenticated using (public.is_email_allowed());
-- writes service-role only (no insert/update/delete policy)
