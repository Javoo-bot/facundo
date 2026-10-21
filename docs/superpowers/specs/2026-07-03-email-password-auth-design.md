# Email/password auth + register + forgot-password

Date: 2026-07-03. Adds email/password sign-in, a self-service register flow **gated to
allow-listed emails**, and forgot/reset-password — alongside the existing Google auth.

**Reverses a documented non-goal.** The brief + `CLAUDE.md` said "Google is the only
provider; do not add email/password." This deliberately changes that; both docs get
updated. The app never handles raw passwords beyond passing them to the Supabase SDK
(Supabase hashes + stores them).

The allow-list boundary is unchanged: `isAllowed` (table-backed, from the editable
allow-list work) still gates every page/route, and RLS remains the hard data boundary.

## 1. Client auth helpers (`lib/auth.ts`)

Add (browser client), alongside the existing `signInWithGoogle`/`signOut`:
- `signInWithPassword(email, password): Promise<{ error: string | null }>` —
  `supabase.auth.signInWithPassword`; on success the session cookie is set, caller
  redirects to `/` (the server components then run the `isAllowed` gate as today).
- `requestPasswordReset(email): Promise<{ error: string | null }>` —
  `supabase.auth.resetPasswordForEmail(email, { redirectTo: ${origin}/auth/callback?next=/auth/reset })`.
- `updatePassword(newPassword): Promise<{ error: string | null }>` —
  `supabase.auth.updateUser({ password })`.

## 2. Register — gated to allow-listed emails (`app/api/auth/register/route.ts`)

`POST { email, password }`, Node runtime:
1. Validate: email format; password length ≥ 8. 400 otherwise.
2. **`isAllowed(email)`** (server-side, table-backed) → **403 "This email isn't authorized
   — ask an admin to add it in Settings."** if not on the list.
3. Create the account with the **service-role admin API**:
   `createServiceClient().auth.admin.createUser({ email, password, email_confirm: true })`
   (auto-confirmed — the allow-list is the trust). On "user already registered" → **409
   "An account already exists — sign in instead."**
4. Return `{ ok: true }`. Never log the password.

*Honest boundary note:* RLS is still the real gate — a direct call to Supabase's public
signup API could create an account, but it would read zero data. Optionally the user can
disable public signups in Supabase to fully close account creation (documented, not
required).

## 3. Callback honors a validated `next` (`app/auth/callback/route.ts`)

Extend the existing OAuth/recovery callback: after `exchangeCodeForSession` + the
`isAllowed` check succeeds, redirect to a `next` query param **only if it's a same-origin
relative path** (`next.startsWith("/") && !next.startsWith("//")`), else `/`. This lets
the password-reset link (`…/auth/callback?next=/auth/reset`) reuse the battle-tested code
exchange + allow-list enforcement (so a de-allow-listed user can't reset into access),
then land on the reset form with a valid recovery session.

## 4. Pages

All are small client components under a minimal auth-card shell (reuse `SignInScreen`'s
card styling):
- **`/auth/register`** — email + password + confirm-password. Submit → `POST
  /api/auth/register`. On success → `signInWithPassword(email, password)` → redirect `/`
  (immediate access). Surfaces 403 (not authorized) / 409 (exists) / validation errors.
- **`/auth/forgot`** — email → `requestPasswordReset` → "Check your email for a reset
  link" confirmation (always shown, even for unknown emails, to avoid account enumeration).
- **`/auth/reset`** — reached via the emailed link (which routed through `/auth/callback`,
  so a recovery session is already set). New-password + confirm form → `updatePassword` →
  redirect `/`. If no session (opened directly), show "This reset link is invalid or
  expired" + a link back to `/auth/forgot`.

## 5. Sign-in screen (`components/SignInScreen.tsx`)

Above the existing Google button, add an **email + password form** (`signInWithPassword`,
inline error on failure) and two links: **"Forgot password?"** → `/auth/forgot`,
**"Register"** → `/auth/register`. Keep the `?error=unauthorized` message. Google stays.

## 6. Docs + Supabase config

- `CLAUDE.md` + `facundo-poc-brief.md`: update the "Google only" non-goal to
  "Google + email/password (register gated to the allow-list)."
- **User's Supabase steps:** enable the **Email** provider (Auth → Providers); confirm the
  app origin + `/auth/callback` are in **Redirect URLs** (already there for OAuth — the
  reset `next` rides on the callback). Reset emails use Supabase's built-in sender (POC;
  custom SMTP optional later).

## 7. Security / edge cases

- Register: `isAllowed` gate before account creation; inputs validated; password never
  logged; existing-user → 409; the route is the only in-app registration path.
- Reset: gated through the callback's `isAllowed`; `next` restricted to same-origin
  relative paths (no open redirect).
- Forgot: same confirmation message regardless of whether the email exists (no
  enumeration).
- Password sign-in for a de-allow-listed account: session sets, but the server-component
  `isAllowed` check bounces it (signOut + unauthorized) — same as OAuth today.
- Supabase enforces its own auth rate limits (brute-force/reset spam) — sufficient for POC.

## 8. Verification

- Add an email to the allow-list (Settings) → register with it → immediate access.
- Register with a non-allow-listed email → 403.
- Register with an existing email → 409.
- Forgot → reset link → set new password → sign in with it.
- Sign out / sign in with email+password works; Google still works.
- A de-allow-listed account is bounced at the next request.

## 9. Non-goals

No other providers (magic links, other OAuth). No email-change flow. No 2FA. No
"remember me"/session-length tuning. No custom transactional email for auth (Supabase's
built-in sender). No admin user-management UI beyond the existing allow-list settings.

## Build note

Cohesive auth change best done by one engineer: `lib/auth.ts` helpers, the register route,
the callback `next` extension, the three pages, the sign-in-screen form, plus the doc
updates. Follow with a security review (register allow-list gate, `next` open-redirect
guard, no password logging, reset flow gated).
