-- Florist multi-user access: a florist owner can invite teammates. App-layer
-- enforced (lib/floristAuth.ts::currentFlorist, lib/floristInvite.ts) — RLS only
-- gates "is this a member of this florist," not owner-vs-member.

alter table florist_users add column role text not null default 'owner'
  check (role in ('owner', 'member'));

-- Denormalized so the team-list UI can show emails without N admin-API calls
-- (there's no bulk "get auth users by id" — only per-id auth.admin.getUserById).
-- Backfilled once here from auth.users; every future insert (both the existing
-- email-match path and the new invite-redemption path) must set it explicitly.
alter table florist_users add column email text;
update florist_users fu set email = au.email from auth.users au where au.id = fu.user_id;
alter table florist_users alter column email set not null;

-- Defense in depth: at most one owner per florist (app logic in
-- /api/florist/team/remove is the primary guard). Safe to add now since every
-- existing florist_id has at most one florist_users row today (no invite
-- mechanism has existed until this migration).
create unique index florist_users_one_owner_idx on florist_users(florist_id) where role = 'owner';

-- Pending/consumed invites a florist owner has sent to teammates.
create table florist_invites (
  id           uuid primary key default gen_random_uuid(),
  florist_id   uuid not null references florists(id) on delete cascade,
  email        text not null,
  token        text not null unique,
  invited_by   text not null, -- inviting owner's email (see florist_notes.author /
                              -- outreach.sent_by for the same plain-email convention)
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '7 days'),
  accepted_at  timestamptz,
  unique (florist_id, email)
);
create index florist_invites_florist_idx on florist_invites(florist_id);
create index florist_invites_token_idx on florist_invites(token);
alter table florist_invites enable row level security;
create policy "florist reads own invites" on florist_invites for select to authenticated
  using (florist_id = public.current_florist_id());
-- No insert/update/delete policy — only the service-role invite/link/revoke routes
-- write here, same pattern as florist_users itself.
