# Florist multi-user access

Date: 2026-07-21. Second of two staff/roles sub-projects (see
`docs/superpowers/specs/2026-07-21-staff-roles-design.md` for the first — staff
permission levels, already shipped). This one lets a florist **shop** — not a
Facundo employee — add teammates to their own account, so more than one person at
a florist can sign into the florist PWA and see the same orders/balance.

**Written autonomously** (per the session's "run to completion" instruction) rather
than through the usual back-and-forth brainstorming — the judgment calls below are
flagged so they're easy to challenge or override before/after implementation.

## Current state

`florist_users(user_id uuid pk, florist_id uuid)` already maps an auth user to a
florist, and `florist_id` has no uniqueness constraint — so the schema has always
technically allowed multiple users per florist. What's missing is any way to *create*
a second mapping. `user_id` **is** the primary key, so one person can never be linked
to more than one florist — that constraint stays as-is and is relied on below.

**Correction from an earlier assumption:** `POST /api/florist/link` exists but is
**dead code** — nothing calls it. The actual auto-link-by-email-match logic is
duplicated inline in `app/florist/(app)/layout.tsx` (lines 19–24), matching this
codebase's established convention of re-doing auth/mapping checks per entry point
rather than centralizing them (same pattern as the staff `(staff)/layout.tsx`). This
spec builds the invite flow into *that* layout, not the unused API route — do not
spend effort modifying `/api/florist/link`.

## Judgment calls (flag before/after building if any of these are wrong)

1. **Two roles within a florist, not four.** `owner` (whoever first linked via the
   existing email-match path) and `member` (anyone invited). Members have **identical
   operational access** to orders/balance/account/payments as the owner — the only
   difference is owners can invite/remove teammates. No finer-grained permissions
   inside a florist shop; that would be over-engineering for a small flower shop's
   staff.
2. **No real invite emails.** Matches this project's existing "drafts are generated,
   not sent" pattern for outreach. Inviting generates a **shareable link** the owner
   copies and sends however they like (WhatsApp, SMS, their own email) — no
   `RESEND_API_KEY` usage added here.
3. **Invite tokens are single-use and expire after 7 days.** Re-inviting the same
   email replaces the pending invite (fresh token + expiry) rather than stacking
   duplicates.
4. **An invitee who already belongs to a florist (their own or a different one)
   cannot redeem a second invite.** Enforced by the existing `user_id` primary key —
   redemption fails gracefully with a clear message rather than a raw constraint
   error.
5. **Owners can't remove themselves or demote to member.** With only two roles and no
   "transfer ownership" flow (YAGNI for now), there must always be exactly the one
   original owner row. If that's wrong (e.g., an owner wants to hand off and leave),
   flag it — that'd need an ownership-transfer step this spec doesn't cover.

## 1. Data model

New migration (`supabase/migrations/2026-07-21-florist-team.sql`):

```sql
-- Role within a florist shop's own team (not to be confused with staff roles —
-- see allowed_emails.role). 'owner' is whoever first linked via email-match;
-- 'member' is anyone who joined via an invite link.
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
-- /api/florist/team/remove is the primary guard — see §6). Safe to add now since
-- every existing florist_id has at most one florist_users row today (no invite
-- mechanism has existed until this migration).
create unique index florist_users_one_owner_idx on florist_users(florist_id) where role = 'owner';

-- Pending/consumed invites a florist owner has sent to teammates.
create table florist_invites (
  id           uuid primary key default gen_random_uuid(),
  florist_id   uuid not null references florists(id) on delete cascade,
  email        text not null,
  token        text not null unique,
  invited_by   text not null, -- inviting owner's email; matches this codebase's
                              -- existing convention of storing the acting user as
                              -- plain email text (florist_notes.author,
                              -- outreach.sent_by), not a uuid FK — avoids an extra
                              -- lookup since currentFlorist() only exposes email
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '7 days'),
  accepted_at  timestamptz,
  unique (florist_id, email) -- re-inviting the same email replaces the row (upsert)
);
create index florist_invites_florist_idx on florist_invites(florist_id);
create index florist_invites_token_idx on florist_invites(token);
alter table florist_invites enable row level security;
create policy "florist reads own invites" on florist_invites for select to authenticated
  using (florist_id = public.current_florist_id());
-- No insert/update/delete policy — only the service-role invite/link/revoke routes
-- write here, same pattern as florist_users itself.
```

Existing `florist_users` rows all predate invites — they were all created via the
original email-match path, so the migration's column default (`'owner'`) is correct
for every existing row with no backfill statement needed.

## 2. Invite lifecycle

- **`POST /api/florist/invite`** `{ email }` — owner-only (see §3 for the auth
  helper). Validates email format, rejects inviting an email that's already a
  `florist_users` member of this florist. Upserts a `florist_invites` row on
  `(florist_id, email)` with a fresh `crypto.randomUUID()` token and
  `expires_at = now() + 7 days`. Returns `{ ok: true, inviteUrl }` where `inviteUrl`
  is `${origin}/florist/invite/${token}` — the owner copies this from the UI.
- **`POST /api/florist/invite/revoke`** `{ inviteId }` — owner-only. Deletes the
  pending invite row (no-op if already accepted/expired — accepted invites aren't
  revocable since the person already joined; use team-remove for that instead).
- **`GET /florist/invite/[token]`** page (new, thin, **outside** the `florist/(app)`
  authenticated group — like `florist/login`). Server-side, service-role lookup of
  the invite by token (no anon RLS policy reaches it, so this must be service-role,
  same pattern as `florist/(app)/layout.tsx`'s existing email-match lookup). If not
  found / expired / already accepted → render a plain "This invite link is no longer
  valid — ask whoever invited you to send a new one." Otherwise `redirect(
  \`/florist/login?invite=${token}\`)`.
- **`app/florist/login/page.tsx`** (modify): read `invite` via `useSearchParams()`.
  When present, show a small banner above the form — "You've been invited to join a
  florist team on Facundo" (generic; no extra fetch for the florist's name, kept
  simple per YAGNI). Post-sign-in, when `invite` is present, redirect to
  `` `/florist/join?invite=${token}` `` instead of `/florist` (all three paths: OAuth
  `redirectTo`, OTP verify, password sign-in). When `invite` is absent, behavior is
  byte-for-byte unchanged (straight to `/florist`).
- **Why a separate `/florist/join` page, not the shared `(app)` layout:** Next.js
  App Router **does not pass `searchParams` to layouts** — only to `page.tsx`
  components. `florist/(app)/layout.tsx` is a layout, so it structurally cannot read
  `?invite=` at all; putting the redemption logic there would silently never fire.
  Redemption instead happens in a dedicated page that *does* receive `searchParams`,
  before the person ever reaches the shared layout in a mapped state.
- **`GET /florist/join`** (new page, `app/florist/join/page.tsx`, **outside** the
  `florist/(app)` group — a sibling of `florist/login`, not wrapped by its layout).
  Reads `?invite=` from `searchParams`. Requires a signed-in session (redirect to
  `/florist/login` if not — shouldn't normally happen, since login already routed
  here post-sign-in). Service-role lookup of the invite by token, then:
  - Not found → render (this page directly, not via the shared layout)
    `NoFloristAccount`-style copy: "This invite link doesn't exist."
  - Found: validate via `canRedeemInvite(invite, user.email, new Date())` (§ Data
    model's pure helper — see §1's migration comment and `lib/floristInvite.ts`).
    Reasons render as: expired → "This invite has expired"; accepted → "This invite
    has already been used"; email mismatch → "This invite was sent to a different
    email address — sign out and sign in with the invited address."
  - If the user already has a `florist_users` row (any florist) → insert fails on
    the `user_id` primary key; catch that and render "You're already linked to a
    florist account — each person can only belong to one," never a raw DB error.
  - On success: insert `florist_users { user_id, florist_id: invite.florist_id,
    role: 'member', email: user.email }`, stamp `accepted_at = now()` on the invite,
    then `redirect("/florist")` — the shared layout's existing `florist_users`
    lookup now finds this row like any other, so no layout change is needed for the
    success path.
- **`app/florist/(app)/layout.tsx`** (small, unrelated-to-invites change): the
  pre-existing email-match auto-link insert (`florist_users { user_id, florist_id:
  florist.id }`) must add `role: 'owner', email: user.email` — required because
  `florist_users.email` becomes `not null` in this migration, so this line breaks
  for every florist's very first login otherwise. This is the **only** change this
  file needs; it does not otherwise participate in invite redemption.
- **`components/florist/NoFloristAccount.tsx`**: **not modified.** Invite errors
  render directly on `/florist/join` using the same simple centered-card markup as
  `/florist/invite/[token]`'s own error states (§2 above) — no shared component or
  prop change needed, since invite errors never flow through the shared layout's
  `!map` branch at all.

## 3. Auth helper — who can manage the team

Extend `lib/floristAuth.ts`:

```ts
export async function currentFlorist(): Promise<{ floristId: string; email: string; role: "owner" | "member" } | null> {
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from("florist_users").select("florist_id, role").eq("user_id", user.id).maybeSingle();
  if (!data) return null;
  return { floristId: data.florist_id, email: user.email ?? "", role: data.role as "owner" | "member" };
}
```

`/api/florist/invite`, `/api/florist/invite/revoke`, and the new
`/api/florist/team/remove` all call `currentFlorist()` and 403 unless
`role === "owner"`.

## 4. Team removal

**`POST /api/florist/team/remove`** `{ email }` — owner-only. Deletes the
`florist_users` row matching that `email` **scoped to the caller's own
`florist_id`** (can't touch another florist's team; targets by email, not
`user_id`, consistent with `currentFlorist()` only exposing email — see §1's
denormalized `email` column). Refuses if `email` (case-insensitive) matches the
caller themselves or if the target row's `role` is `'owner'` (there's always
exactly one owner — no removal path for it, per judgment call #5).

## 5. UI — `FloristAccount.tsx`

Add a "Team" section (visible to both roles, controls only for `owner`):

- List every `florist_users` row for this florist (`email` is now a column on
  `florist_users` itself — see §1 — so no join/admin-API call is needed; the *page*
  fetches the full team list server-side with the service client, since
  `florist_users` RLS only exposes the caller's own row, scoped to
  `currentFlorist().floristId`) with their role badge (Owner/Member) and join date.
- **Owner view** additionally gets: pending-invites list (email, sent date, expiry,
  a "Revoke" button, a "Copy link" button that re-fetches/display the still-valid
  `inviteUrl`) and an "Invite a teammate" form (email input → `POST
  /api/florist/invite` → show the returned link with a copy button — no email is
  sent, so surfacing the link directly is the whole UX). Each member row (except the
  owner's own) gets a "Remove" button → `POST /api/florist/team/remove`.
- **Member view**: read-only list of teammates, no invite form, no remove buttons.

## 6. Security / edge cases

- Invite tokens are opaque `crypto.randomUUID()` values (122 bits of randomness) —
  unguessable, and single-use once `accepted_at` is set.
- The invite-redemption email check (invite email must match the signer's actual
  email) prevents a forwarded link from letting an unintended person join.
- The `user_id` primary key on `florist_users` is the actual enforcement for
  "one person, one florist" — the app-level check in the layout's invite-redemption
  block just turns what would otherwise be a raw Postgres unique-violation into a
  clear message.
- Owners can't remove themselves or the last owner — always exactly one owner row per
  florist. Primarily enforced in `/api/florist/team/remove`'s app logic, backed by
  the `florist_users_one_owner_idx` partial unique index from §1 as defense in depth.
- Expired invites are inert (checked on both the invite-landing page and the layout's
  redemption block) but not actively deleted — a cheap cron/cleanup isn't in scope
  (POC-level; a handful of stale rows per florist is harmless).

## 7. Verification

- Owner invites a teammate email → gets a link → opens it in a private window → signs
  in with that exact email (Google or OTP) → lands in the florist app with the same
  orders/balance the owner sees.
- Opening the same invite link signed in as a **different** email → rejected with the
  email-mismatch message.
- Opening an expired or already-accepted invite link → "no longer valid" message, no
  crash.
- A member cannot see the invite form or remove buttons in the Team section; hitting
  `/api/florist/invite` directly as a member → 403.
- Owner cannot remove themselves; the UI doesn't even show a Remove button on their
  own row, and the API 403s if attempted directly.
- A person already linked to florist A who tries to redeem an invite to florist B →
  rejected with the "already linked" message, no orphaned/duplicate `florist_users`
  row.

## 8. Non-goals

No ownership transfer. No per-member permission granularity beyond owner/member. No
real invite emails (link-copy only, matching this project's existing outreach-draft
convention). No team size limit. No audit log of team changes. No self-service "leave
a team" flow for members (an owner removes them instead) — if a member wants to leave
unilaterally, that's a manual DB fix for now, same tier as other POC-level gaps.

## Build note

Smaller than the staff-roles sub-project: one migration, one auth-helper extension,
three new API routes, two new pages (`/florist/invite/[token]`, `/florist/join`), a
small unrelated-to-invites layout fix (the `email`/`role` insert columns), and one
component section. A single engineer can do this in one pass. Follow with a security
review focused on: the email-match check on invite redemption, the
one-person-one-florist guarantee, the owner-only gates on invite/revoke/remove, and
that `searchParams` is only ever read in `page.tsx` files, never the shared layout.
