-- Staff roles: replaces the flat allowed_emails boolean with four permission levels.
-- App-layer enforced (lib/allowlist.ts::getStaffRole, lib/apiAuth.ts::requireRole) —
-- RLS is untouched, still just gates "is this person staff at all."
alter table allowed_emails add column role text not null default 'ops'
  check (role in ('admin', 'ops', 'finance', 'read_only'));

-- Named admins keep full access with no behavior change. Every other existing row
-- lands on the column default ('ops').
update allowed_emails set role = 'admin'
  where email in ('user@example.com', 'marketing@fc.example.com');
