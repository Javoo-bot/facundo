-- Outreach CRM (email v1): singleton settings + a per-send audit log.
create table if not exists app_settings (
  id          integer primary key default 1,
  test_mode   boolean not null default true,   -- SAFE DEFAULT: ON
  test_email  text,
  test_phone  text,                             -- reserved for future SMS/WhatsApp
  updated_at  timestamptz not null default now(),
  constraint app_settings_singleton check (id = 1)
);
insert into app_settings (id) values (1) on conflict (id) do nothing;
alter table app_settings enable row level security;
create policy "allowlisted read app_settings" on app_settings
  for select to authenticated using (public.is_email_allowed());

create table if not exists outreach (
  id                  uuid primary key default gen_random_uuid(),
  florist_id          uuid not null references florists(id) on delete cascade,
  channel             text not null default 'email',
  status              text not null,
  intended_address    text,
  to_address          text,
  test_mode           boolean not null,
  subject             text,
  body                text,
  provider_message_id text,
  error               text,
  sent_by             text,
  sent_at             timestamptz not null default now(),
  constraint outreach_status_check  check (status in ('sent','failed')),
  constraint outreach_channel_check check (channel in ('email'))
);
alter table outreach enable row level security;
create policy "allowlisted read outreach" on outreach
  for select to authenticated using (public.is_email_allowed());
