# Outreach CRM — email v1 (with test mode)

Date: 2026-07-03. Turns the stored `drafted_email` per florist into a real outreach
action: select florists → review/edit the email → send via Resend → record it as a CRM
history. A configurable **test mode (default ON)** redirects every send to a predefined
test address so real florists can never be contacted by accident.

**Reverses a documented non-goal.** The brief + `CLAUDE.md` said "drafts only, do not
send." This deliberately changes that, with test-mode-by-default as the safety. v1 is
**email only**; SMS/WhatsApp are schema-ready (a `test_phone` field) but not built.

This is a **dashboard + Supabase** feature — the ingest CLI is unchanged.

## 1. Data model (2 new tables)

### `app_settings` — singleton config
```sql
create table app_settings (
  id          integer primary key default 1,
  test_mode   boolean not null default true,   -- SAFE DEFAULT: ON
  test_email  text,                             -- all email goes here in test mode
  test_phone  text,                             -- reserved for future SMS/WhatsApp; unused in v1
  updated_at  timestamptz not null default now(),
  constraint app_settings_singleton check (id = 1)
);
insert into app_settings (id) values (1) on conflict (id) do nothing;
alter table app_settings enable row level security;
create policy "allowlisted read app_settings" on app_settings
  for select to authenticated using (public.is_email_allowed());
-- no insert/update policy: written only via the service-role settings route.
```

### `outreach` — the CRM record (one row per send attempt)
```sql
create table outreach (
  id                  uuid primary key default gen_random_uuid(),
  florist_id          uuid not null references florists(id) on delete cascade,
  channel             text not null default 'email',
  status              text not null,            -- 'sent' | 'failed'
  intended_address    text,                     -- the florist's real email
  to_address          text,                     -- who it ACTUALLY went to (test_email in test mode)
  test_mode           boolean not null,         -- was this a test send
  subject             text,
  body                text,                     -- snapshot of what was sent (post-edit)
  provider_message_id text,                     -- Resend id, null on failure
  error               text,
  sent_by             text,                     -- session user email who triggered it
  sent_at             timestamptz not null default now(),
  constraint outreach_status_check  check (status in ('sent','failed')),
  constraint outreach_channel_check check (channel in ('email'))
);
alter table outreach enable row level security;
create policy "allowlisted read outreach" on outreach
  for select to authenticated using (public.is_email_allowed());
-- no insert/update policy: written only via the service-role send route.
```

Migrations + `schema.sql` parity. Both readable by allow-listed users (dashboard shows
mode + CRM history); both written only server-side via service-role (the exclude
pattern).

## 2. Email sender (`lib/email.ts`)

A thin server-only wrapper so the provider is swappable:
```ts
export async function sendEmail(args: { to: string; from: string; subject: string; body: string })
  : Promise<{ ok: true; id: string } | { ok: false; error: string }>
```
Implemented with `fetch` to the Resend REST API (`POST https://api.resend.com/emails`,
`Authorization: Bearer RESEND_API_KEY`, JSON `{ from, to, subject, text }`) — no new npm
dependency. Returns the Resend message id or a readable error. Never throws.

Env (dashboard, server-only, in `.env.local`): `RESEND_API_KEY`, `RESEND_FROM` (e.g.
`"Facundo <onboarding@resend.dev>"`). **Setup caveat (documented, not a code issue):**
Resend only delivers to arbitrary addresses from a *verified sender domain*; for test
mode to your own inbox, set `test_email` to an address Resend will accept (your Resend
account email, or an address on a verified domain). Live sending to florists requires a
verified domain.

## 3. API routes (all Node runtime, `dynamic="force-dynamic"`, auth-gated)

Every route: `getUser()` + `isAllowed(user.email)` → 401/403 before any service-role
work (the exclude/`supabaseAdmin` pattern).

### `POST /api/settings`
Body `{ test_mode: boolean, test_email: string|null, test_phone: string|null }`. Validates:
`test_email` must be a plausible email (`/^[^@\s]+@[^@\s]+\.[^@\s]+$/`) when `test_mode`
is true (can't be in test mode with no valid redirect target). Service-role `update
app_settings set ... where id = 1`. Returns `{ ok: true }`.

### `POST /api/outreach/send` — the core
Body `{ items: [{ floristId: string, subject: string, body: string }] }` (1..50 items).
Server:
1. Auth-gate; capture `sent_by = user.email`.
2. **Read `app_settings` server-side** (service-role) — authoritative `test_mode` /
   `test_email`. If `test_mode` and no valid `test_email` → 400 (refuse to send).
3. For each item (bounded, e.g. ≤5 concurrent; per-item try/catch — one failure never
   aborts the batch):
   - Fetch the florist (`id, name, email`) via service-role. Skip with a `failed` record
     if it has no email.
   - `intended = florist.email`; `recipient = test_mode ? test_email : florist.email`.
   - `sendEmail({ to: recipient, from: RESEND_FROM, subject, body })`.
   - Insert an `outreach` row: status `sent`/`failed`, `intended_address=intended`,
     `to_address=recipient`, `test_mode`, `subject`, `body`, `provider_message_id`/`error`,
     `sent_by`.
4. Return `{ results: [{ floristId, status, error? }], test_mode, to_hint }` so the UI can
   show per-florist outcomes and which mode ran.

The client CANNOT override test mode — it's read from the DB server-side every send.

## 4. UI

### `/settings` page (new)
Server component (auth-gate, read `app_settings`) → `SettingsClient`:
- Toggle **Test mode** (default ON), input **Test email** (required when test mode on),
  input **Test phone** (labeled "for future SMS/WhatsApp — not used yet", optional).
- Save → `POST /api/settings` → success toast. A prominent explainer: *"Test mode ON:
  every email is redirected to the test address; real florists are never contacted."*
- Reachable from a **gear/Settings link** added to the overview + city headers.

### City-page multi-select + send
- `FloristTable` gains a **checkbox column**; only florists with an email are selectable
  (others disabled). Selection state lifts to `DashboardClient` (a `Set<floristId>`), with
  a header "select all sendable".
- When ≥1 selected, a toolbar shows **"Review & send (N)"**.
- `OutreachSendPanel` (modal): for each selected florist, an **editable subject + body**
  (pre-filled by splitting `drafted_email` on its leading `Subject:` line; if absent,
  subject defaults to a short fallback and body is the whole draft). A prominent **mode
  banner**: 🧪 *"TEST MODE — all emails go to `<test_email>`"* or 🔴 *"LIVE — emails go to
  the real florists"* (from settings passed as props by the city server component).
- **Send**: in LIVE mode, an extra confirm step (*"You're about to email N real
  florists."*) first. → `POST /api/outreach/send` → show per-florist results (✓/✗) →
  `router.refresh()`.

### CRM surfacing
- The city server component also fetches `outreach` for its florists (RLS read); a
  florist with a `sent` row gets a subtle **"contacted"** badge in the table.
- The detail drawer (`ScoreBreakdown`) shows the florist's **outreach history** (most
  recent: when, to which address, test/live, status).

## 5. Safety model (the crux)

- `test_mode` defaults **true** in the DB.
- The send route reads `test_mode` **server-side from the DB every send** — the client
  can't spoof it.
- Test mode redirects `to_address` to `test_email`; the florist's real address is only
  recorded as `intended_address`, never sent to.
- LIVE mode requires the toggle off **and** an explicit in-panel confirm.
- Every send is recorded (sent or failed) with which address it hit and the mode — a full
  audit trail.

## 6. Edge cases

- Test mode on, `test_email` empty/invalid → settings save rejects it; send route 400s.
- A selected florist lost its email (edge) → recorded `failed` ("no email"), batch
  continues.
- Resend key missing/invalid → each send recorded `failed` with the provider error; the
  UI shows it; nothing crashes.
- Duplicate sends are allowed (no dedup) — each is its own `outreach` row (you can email
  the same florist twice); the "contacted" badge just reflects "≥1 sent".
- Signed-out: settings + outreach never leak (RLS); routes 401.

## 7. Verification

- Migrations applied; `app_settings` seeded (test_mode=true), `outreach` present.
- `/settings`: set test mode ON + your test email; save.
- City page: select 2–3 florists with emails → Review & send → edit one → Send → the
  emails **arrive at your test address** (not the florists); per-florist ✓ shows; the
  `outreach` rows record `to_address=test_email`, `intended_address=<florist>`,
  `test_mode=true`; "contacted" badges appear.
- Flip test mode OFF → the panel shows the LIVE banner + confirm. (Do NOT actually send
  live to real florists during verification — confirm the banner/guard, then cancel, or
  send live only to a florist address you control.)
- Signed-out: no leak; routes 401.

## 8. Non-goals (v1)

SMS/WhatsApp (schema-ready, not built). No reply/open/delivery tracking (needs inbound
webhooks). No cross-city bulk send (per-city only). No scheduling, sequences, or
templates beyond the existing draft. No un-send. No per-florist send throttling beyond a
small concurrency cap. No contact-status pipeline (interested/won/lost) — just
sent/failed history.

## Build split (both in `dashboard/` + `supabase/`)

- **backend-engineer** → `supabase/` + dashboard server-side: `app_settings` + `outreach`
  migrations & schema, `lib/email.ts` (Resend), `POST /api/settings`, `POST
  /api/outreach/send`, `.env.local` (`RESEND_API_KEY`, `RESEND_FROM`). Reuses
  `lib/supabaseAdmin.ts::createServiceClient`.
- **frontend-engineer** → dashboard UI: `/settings` page + `SettingsClient`, `FloristTable`
  multi-select, `OutreachSendPanel`, CRM badges + detail-drawer history, settings nav
  link, `lib/types.ts` (`AppSettings`, `Outreach`). Builds against the route contracts +
  table shapes fixed above.
