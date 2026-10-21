# Staff roles & permissions

Date: 2026-07-21. Replaces the flat `allowed_emails` boolean allow-list (every
allow-listed staff member has full access today, including payments/card reveal and
managing the allow-list itself) with four permission levels: **Admin**, **Ops**,
**Finance**, **Read-only**.

**Reverses a documented non-goal.** `CLAUDE.md` lists "No role management / invites /
user admin UI" as a POC non-goal. The codebase has outgrown that framing (payments,
Airwallex cards, a florist PWA, escalations, trust tiers) — this spec updates that line
alongside the change. This is the first of two sub-projects; florist multi-user access
(letting a florist shop invite teammates) is a separate follow-up spec.

## 1. Data model

Add a `role` column to `allowed_emails`:

```sql
alter table allowed_emails add column role text not null default 'ops'
  check (role in ('admin', 'ops', 'finance', 'read_only'));
```

`isAllowed(email)` (`lib/allowlist.ts`) stays a **pure membership check** — unchanged,
still used by self-registration (which runs before any session/role exists) and as the
base RLS predicate (`is_email_allowed()` is untouched; RLS still just gates "is this
person staff at all," not role). Add `getStaffRole(email): Promise<Role | null>` next to
it, same fail-closed pattern (any DB error or exception → `null`, treated as no access).

## 2. Enforcement: app-layer, not RLS

Role checks live in the API routes/server components, not in RLS. RLS keeps gating
table-level "is this a staff member" access (unchanged); the role narrows what the
*app* lets that member do on top of that. This matches the existing pattern
(`isAllowed` is already an app-layer + RLS combo) and avoids rewriting policies across
every sensitive table for a still-evolving project.

`lib/apiAuth.ts` gets a new helper alongside `requireAllowedUser`:

```ts
export async function requireRole(
  ...roles: Role[]
): Promise<{ ok: true; email: string; role: Role } | { ok: false; res: Response }> {
  const base = await requireAllowedUser();
  if (!base.ok) return base;
  const role = await getStaffRole(base.email);
  if (!role || !roles.includes(role)) {
    return { ok: false, res: jsonError("Your role doesn't allow this.", 403) };
  }
  return { ok: true, email: base.email, role };
}
```

Every route that needs to be narrower than "any staff member" swaps
`requireAllowedUser()` for `requireRole("admin", "ops")` (or whichever roles apply) — a
one-line diff per route. Routes not listed in the matrix below keep
`requireAllowedUser()` (any staff role).

Server *components* (staff pages) use the same `getStaffRole` to decide what to render
(hide nav items / whole pages a role can't use) — checked server-side, not just hidden
in the client, so a direct URL hit still 403s via the route-level check underneath.

## 3. Permission matrix

| Area | Read-only | Ops | Finance | Admin |
|---|---|---|---|---|
| Orders/florists/discovery/CX pages — view | ✅ | ✅ | — | ✅ |
| Orders/florists — mutate (assign, reassign, rematch, status, resolve-escalation, issue reply/resolve, photo, notes, meetings, exclude, stage, reachout/outreach send, draft-email, ingest trigger, keywords) | — | ✅ | — | ✅ |
| Trust tiers (`/admin/tiers`, `/api/trust-tiers`) | — | ✅ | — | ✅ |
| Florist "Operational" section (trust tier/source/radius/capacity/payout terms/hours — `/florists/[id]`, `/api/florists/operational`) | — | ✅ | — | ✅ |
| SYSTEM pages: Order lifecycle (`/lifecycle`), External ops (`/operations`), Jobs (`/jobs`) | — | ✅ | — | ✅ |
| Payments area (`/payments*`, card reveal, close payout, payout approve/reject) — whole page + APIs | — | — | ✅ | ✅ |
| Orders/florists — **read-only** context (for payout disputes) | n/a | n/a | ✅ | ✅ |
| Settings (`/settings`, `/api/allowlist`, `/api/settings`) — role/allow-list management, test-mode toggle | — | — | — | ✅ |
| Dev/test utilities (`/api/dev/mock-order`) | — | ✅ | — | ✅ |
| System endpoints (`/api/orders/waves/tick`, `/api/outbox/drain`) — cron secret OR any staff session | ✅ | ✅ | ✅ | ✅ |

Payments is a walled garden: Ops and Read-only don't see it at all (page-level gate),
since it includes card PAN reveal and ledger data. Finance is the mirror image —
payments plus read-only order/florist context, no mutation there. Anything not listed
(viewing your own profile, signing out) is unrestricted for any staff role.

Concretely, the two orders/florists rows combine to one page-level rule: the
Orders/florists/discovery/CX **pages** are viewable by all four roles (including
Finance); only the **mutation actions** within them (row 2) are gated to Ops/Admin. A
Finance or Read-only session sees the same page with mutation buttons/routes disabled.

Jobs (`/jobs`), Order lifecycle (`/lifecycle`), and External ops (`/operations`) are a
separate, narrower rule: Ops/Admin only, page + nav (not just mutation-disabled) — a
Read-only or Finance session gets `<Forbidden>` on direct URL hit, and the sidebar hides
the links entirely. Same for the florist "Operational" section, whose write API
(`/api/florists/operational`) was already Ops/Admin-gated — the section is now hidden
for other roles too, rather than shown with controls that would just 403 on save.

## 4. Settings UI

- The "Authorized emails" section gets a role picker per row (`admin` / `ops` /
  `finance` / `read_only`). Adding a new email requires picking a role at add-time — no
  silent default in the UI (the DB default of `'ops'` only applies to the migration
  backfill, not new additions).
- Changing a row's role is a `PATCH /api/allowlist` (new; alongside the existing
  `POST`/`DELETE`) — service-role write, same auth gate.
- **Last-admin guard**: `PATCH`/`DELETE` on `allowed_emails` blocks demoting or removing
  the last remaining `admin` row (count `role = 'admin'` before applying the change;
  reject with 400 if it would hit zero). Mirrors the existing "can't remove your own
  access" guard in the same route.
- Only Admins can reach `/settings` at all (already true today — the whole page is
  allow-list-gated; this spec narrows that further to `requireRole("admin")`).
- Nav: staff layout hides sidebar entries the current role can't use (e.g., Payments
  for Ops) rather than leaving a dead link that 403s on click.

## 5. Migration & rollout

One migration (`supabase/migrations/<date>-staff-roles.sql`):

```sql
alter table allowed_emails add column role text not null default 'ops'
  check (role in ('admin', 'ops', 'finance', 'read_only'));

update allowed_emails set role = 'admin'
  where email in ('user@example.com', 'marketing@fc.example.com');
```

Every other existing row lands on the column default (`'ops'`). `user@example.com`
and `marketing@fc.example.com` keep full access with no behavior change. Everyone else loses
Payments and Settings access until an admin explicitly reassigns them — **flag this to
the team before/at rollout** so no one is surprised mid-task.

## 6. Small cleanup (same-file, not scope creep)

`app/api/allowlist/route.ts` currently has its own local copy of the allow-list gate
instead of importing `requireAllowedUser` from `lib/apiAuth.ts`. Since this file is
already being edited to add role support (the new `PATCH` handler + last-admin guard),
dedupe it onto the shared helper rather than maintaining two copies.

## 7. Security / edge cases

- Role check always runs server-side (route handlers / server components); hiding a nav
  item is UX, never the actual boundary.
- `isAllowed` (membership) and `getStaffRole` (role) are both fail-closed: any DB error
  or exception denies the stricter outcome (no access / no elevated role).
- Last-admin guard is checked server-side before the DB write, same pattern as the
  existing "can't remove your own access" check.
- A role change takes effect on the *next* request (no session invalidation needed —
  every gated route re-checks `getStaffRole` per request, it isn't cached in the JWT).
- Self-registration (`/api/auth/register`) is unaffected: it only checks `isAllowed`
  (membership); the row's role (already set by an admin before this point) applies from
  the user's very first sign-in.

## 8. Verification

- Demote/remove the last Admin → blocked with a clear error.
- An Ops account: can view+mutate orders/florists/trust-tiers; hitting any
  `/payments*` page or API directly → 403; `/settings` → 403.
- A Finance account: can view+act on payments (including card reveal); can view (not
  mutate) orders/florists; `/settings` → 403.
- A Read-only account: can view orders/florists/discovery/CX/jobs; every mutation route
  and the entire Payments/Settings area → 403; nav doesn't show hidden areas.
- Run the migration against a copy of the current allow-list; confirm the two named
  admins keep full access and everyone else defaults to Ops with no crash.

## 9. Non-goals

No per-resource fine-grained permissions (e.g., "Ops but only for city X"). No
role-aware RLS rewrite (app-layer only, per §2). No audit log of role changes (out of
scope for this pass — could be a `florist_notes`-style follow-up). No self-service role
requests — an existing Admin always makes the change via Settings.

## Build note

Cohesive change best done by one engineer: the migration, `getStaffRole` +
`requireRole`, swapping the relevant routes' gate per the matrix in §3, the
Settings UI role picker + `PATCH` handler + last-admin guard, and the nav-hiding in the
staff layout. Follow with a security review focused on: every payments/settings route
actually using `requireRole` (not just the page), the last-admin guard, and that no
route in the matrix was missed.
