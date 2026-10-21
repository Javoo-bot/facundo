# Editable allow-list (settings)

Date: 2026-07-03. Make the Google-auth allow-list editable from the `/settings` page,
with the `allowed_emails` table as the **single runtime source of truth** so edits take
effect immediately for sign-in and every gate — not just RLS.

## Problem: two sources of truth today

- `allowed_emails` table + `is_email_allowed()` (SECURITY DEFINER) — the **RLS** boundary.
- `ALLOWED_EMAILS` env — what `lib/auth.ts::isAllowed()` checks for the OAuth-callback
  bounce and the API-route/server-component gates.

You can't edit an env from a UI, and a stale env means a newly-added user is allowed by
RLS yet bounced at sign-in. Fix: `isAllowed` reads the **table**.

## 1. `isAllowed` → server-only, async, table-backed, fail-closed

- **New `dashboard/lib/allowlist.ts`** (server-only):
  ```ts
  import { createServiceClient } from "@/lib/supabaseAdmin";
  export async function isAllowed(email: string | null | undefined): Promise<boolean> {
    if (!email) return false;
    try {
      const admin = createServiceClient();
      const { data, error } = await admin
        .from("allowed_emails").select("email").eq("email", email.toLowerCase()).limit(1);
      if (error) return false;          // FAIL CLOSED
      return (data?.length ?? 0) > 0;
    } catch { return false; }           // FAIL CLOSED
  }
  ```
- **Remove `isAllowed` from `lib/auth.ts`** — that module is imported by client code
  (`signInWithGoogle`/`signOut` use the browser client), and `isAllowed` now imports the
  server-only `supabaseAdmin`; keeping them together would pull the service-role client
  into the client bundle. `lib/auth.ts` keeps only the client sign-in/out helpers.
- **Update every call site** to import from `@/lib/allowlist` and `await` it:
  `app/auth/callback/route.ts`, `app/page.tsx`, `app/city/[id]/page.tsx`,
  `app/jobs/page.tsx`, `app/settings/page.tsx`, and all `app/api/*/route.ts`
  (`ingest`, `keywords`, `jobs`, `settings`, `outreach/send`, `florists/exclude`). All are
  already async, so `if (!(await isAllowed(email)))` is a clean change.
- `ALLOWED_EMAILS` env becomes **seed-only** (documented): it's no longer read at runtime;
  it's just a convenience for seeding the table on first setup. `CLAUDE.md` updated.

## 2. Allow-list management API — `app/api/allowlist/route.ts`

Auth-gated (session + `isAllowed`) service-role writes, Node runtime:
- `POST { email }` → validate email format, lowercase, `insert ... on conflict do nothing`
  into `allowed_emails`. Returns `{ ok: true }`.
- `DELETE { email }` → **guard: refuse to remove the caller's own email**
  (`email.toLowerCase() === user.email.toLowerCase()` → 400 "You can't remove your own
  access."). Otherwise `delete from allowed_emails where email = ...`. Returns `{ ok: true }`.
  The own-email guard is **server-enforced** (not just a disabled button).

## 3. Settings UI

- `app/settings/page.tsx` (server component) also reads the allow-list via the
  service-role client (the table has no RLS read policy — it's the security boundary) and
  passes `allowedEmails: string[]` + the current `userEmail` to `SettingsClient`.
- `SettingsClient` gains an **"Authorized emails"** section: the current list, each row
  with a **Remove** button (disabled for the signed-in user's own email, with a hint),
  and an **add email** input + button. Add → `POST`, Remove → `DELETE` → `router.refresh()`.
  Basic email-format validation client-side; the server re-validates.

## 4. Edge cases / safety

- Empty table or a DB error in `isAllowed` → **deny** (fail closed) — never lock the door
  open. (The table is seeded with `user@example.com`, so the owner isn't locked out.)
- Removing your own email is blocked both in the UI and the route.
- RLS is unchanged — `is_email_allowed()` already reads the table; edits affect it too.
- Signed-out: the allow-list is never exposed (settings page is auth-gated; the table has
  no anon read path).
- Every `isAllowed` call now hits the DB (once per gate) — fine at POC scale.

## 5. Verification

- Add an email in `/settings` → it appears; that person can sign in (RLS + gate both allow).
- Remove an email → they lose access on next request; your own email's Remove is disabled
  and the DELETE route rejects it if forced.
- Empty/adverse DB → sign-in denied (fail-closed), not opened.
- Signed-out: `/settings` + `/api/allowlist` → 401; no list leak.

## 6. Non-goals

No roles/permissions (flat allow-list). No per-email metadata (added-by/when). No bulk
import. No invite emails. Google remains the only provider.

## Build note

Single cohesive change (auth module move + call-site updates + one route + one settings
section) — best done by one engineer to keep the `isAllowed` signature change consistent
across all call sites. Follow with a security-focused review (fail-closed, no service-role
leak to client bundle, own-email guard server-enforced).
