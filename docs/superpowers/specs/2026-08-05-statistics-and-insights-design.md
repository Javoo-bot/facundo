# Operations statistics & insights

Date: 2026-08-05. Adds a `/statistics` page — usage, orders, acceptance/refusals,
fulfilment, issues, logins, and email engagement, charted over an adjustable date
range — plus an LLM chat on the same page that can answer free-form questions by
writing read-only SQL against the live schema.

Read-only reporting on top of the existing order loop; it does not change any
order-loop stage or branch behavior, so `lib/lifecycle.ts` is untouched.

## 1. New data captured

Two things staff already asked about aren't captured anywhere today: sign-ins, and
email delivery/engagement events. Both get a new table.

### `login_events`

```sql
create table login_events (
  id          uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  surface     text not null check (surface in ('staff', 'florist')),
  user_email  text,                                    -- staff sign-ins
  florist_id  uuid references florists(id) on delete set null,  -- florist sign-ins
  method      text not null check (method in ('google', 'password', 'magic_link')),
  user_agent  text
);
create index login_events_occurred_idx on login_events(occurred_at desc);
create index login_events_florist_idx on login_events(florist_id, occurred_at desc);
```

RLS: staff read via the allow-list (`is_email_allowed()`), same as every other
reporting table; no florist read policy (florists have no reason to see this) and no
write policy — inserts go through the service-role client only, from each sign-in
call site itself (not a trigger, since staff and florist sign-in run through
different code paths and Supabase's own `auth.users`/`auth.sessions` aren't
reliably queryable from the app):

- Staff Google OAuth — `app/auth/callback/route.ts`, after the allow-list check
  passes.
- Staff email/password sign-in.
- Florist email/password sign-in — `app/florist/login/page.tsx`'s server action /
  route.
- Florist magic-link redemption — `app/florist/m/[token]/route.ts`, the branch that
  mints a real florist session (not the staff-keeps-session branch).

Each site fires a best-effort, fire-and-forget insert (a `login_events` write must
never fail or delay an actual sign-in).

### `email_events`

```sql
create table email_events (
  id               uuid primary key default gen_random_uuid(),
  communication_id uuid references communications(id) on delete set null,
  event_type       text not null check (event_type in
                      ('delivered', 'opened', 'clicked', 'bounced', 'complained')),
  occurred_at      timestamptz not null default now(),
  raw              jsonb not null
);
create index email_events_comm_idx on email_events(communication_id);
create index email_events_occurred_idx on email_events(occurred_at desc);
```

Populated by a new `app/api/webhooks/resend/route.ts`, verified against Resend's
webhook signing secret (new env var `RESEND_WEBHOOK_SECRET`; Resend signs with
Svix — verify with `svix` or the raw HMAC per their docs). For each event, look up
`communications` by `provider_message_id = payload.data.email_id and
provider = 'resend'` and set `communication_id` if found; insert the row regardless
(with `communication_id null`) if not, so a lookup miss never drops an event.
Registering the webhook URL in Resend's dashboard is a manual step outside this
change.

RLS: staff read via the allow-list; no write policy (service-role only, from the
webhook route, which authenticates via signature rather than a staff session).

## 2. The Statistics page

New `app/(staff)/statistics/page.tsx`, gated `ops`/`admin` via `requireRole` /
`getStaffAccess`, same pattern as `/admin/tiers`. Added to `StaffShell`'s
OPERATIONS section, between Communications and the PARTNERS group.

A date-range control at the top (presets: 7d / 30d / 90d, plus custom; default 30d)
drives every section below. Each section is its own typed query function in a new
`lib/stats.ts`, called from the server component — not the chat's generic SQL
executor, which is reserved for free-form questions.

| Section | Metrics | Source |
|---|---|---|
| Orders | Volume over time; breakdown by status | `orders` |
| Acceptance & refusals | Accept rate; decline-reason breakdown (pre-accept); release-reason breakdown (post-accept) — kept as two separate charts, since they mean different things | `order_assignments` |
| Fulfilment | Delivery completion rate; on-time rate (`delivered_at` vs `sla_deadline_at`); time-to-delivery distribution | `order_assignments`, `delivery_events` |
| Issues | Count by `type`; open vs resolved; resolution-time distribution | `order_issues` |
| Usage | Active florists by day; florist responsiveness (offer sent → accept/decline latency) | `login_events`, `order_assignments` |
| Logins | Staff and florist sign-ins over time | `login_events` |
| Emails | Sent → delivered → opened → clicked funnel, plus bounce/complaint rate | `communications`, `email_events` |

Charts render with **Recharts** (new dependency — nothing in `dashboard/package.json`
charts today), styled to `design-system.css`. Colors/accessibility follow the
`dataviz` skill's palette and mark guidance at implementation time.

All queries guard nulls the same way the rest of the app does (a missing
`decline_reason`/`delivered_at`/etc. must not blow up a chart) — same convention as
the scoring-math null guards `CLAUDE.md` already calls out.

## 3. The LLM chat

A panel on the same page. `app/api/stats/chat/route.ts`, same `ops`/`admin` gate.

**Provider**: OpenRouter, via plain `fetch()` against
`https://openrouter.ai/api/v1/chat/completions` with forced tool-calling — the
existing pattern in `dashboard/lib/photoVerify/openrouter.ts`, not the Anthropic
SDK. (Migrating the *existing* direct-Anthropic call sites — the photo-verification
payout gate and draft-email — to OpenRouter is explicitly out of scope here; see
§5.)

**Model**: chosen from a Settings-page dropdown, new `app_settings.stats_chat_model`
column (`text not null default 'anthropic/claude-sonnet-4.5'`), mirroring the
existing provider-toggle UI pattern in Settings. That default gets confirmed (and
corrected if OpenRouter's live catalog uses a different slug) at implementation
time — same live-catalog check the shadow-mode photo-verification picks already
went through; the dropdown offers a short vetted list (that Claude model, plus one
or two alternatives such as a Gemini or GPT model already reachable through the
same OpenRouter key).

**Schema context**: the system prompt describes an explicit table allowlist —
`orders`, `order_line_items`, `order_assignments`, `delivery_events`, `florists`,
`order_issues`, `communications`, `email_events`, `login_events`, `cities`,
`trust_tiers`, `payouts`, `outreach` — with each table's columns and a short note on
what it means (e.g. `order_assignments.status` values, what `decline_reason` vs
`resolution_action` mean). This lets the model join freely — "which florist has the
most declines in Girona this month" needs `order_assignments` joined to `florists`
joined to `cities`, filtered by `decline_reason is not null`.

**Tool**: one function, `run_sql(query: string)`. On a tool call:

1. **App-level regex gate**, before anything touches the database: reject unless
   the trimmed query is a single statement (no `;` except an optional trailing one,
   which is stripped) starting with `select` or `with` (case-insensitive), and
   reject if it contains any of `insert|update|delete|drop|alter|truncate|grant|
   revoke|create|copy|vacuum|call|do|pg_sleep|pg_terminate_backend|lock` as a
   whole word.
2. **DB-level enforcement**, via a new Postgres function:

   ```sql
   create or replace function run_readonly_stats_query(q text)
   returns jsonb
   language plpgsql
   security definer
   set search_path = public
   as $$
   declare
     result jsonb;
   begin
     -- allowlist: q may only reference these tables (checked via a parse of
     -- referenced relations, or — simpler and sufficient given the app-level
     -- regex already ran — a second keyword scan against a denylist of the
     -- sensitive tables themselves: allowed_emails, staff_roles,
     -- admin_card_issuance, payment_events).
     if q ~* '\m(allowed_emails|staff_roles|admin_card_issuance|payment_events)\M' then
       raise exception 'query references a restricted table';
     end if;

     perform set_config('statement_timeout', '5000', true);
     perform set_config('transaction_read_only', 'on', true);

     -- row cap enforced by wrapping the caller's query in an outer LIMIT,
     -- not by trusting it to LIMIT itself
     execute format(
       'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) sub limit 500) t',
       q
     ) into result;

     return result;
   end;
   $$;
   ```

   (The point held here is that both the timeout and the read-only transaction
   are enforced by Postgres itself, not just app code — exact wrapping SQL may
   be adjusted at implementation time, e.g. if the caller's query already ends
   in `order by`, which a naive wrap can break.)

   Called via the existing service-role Supabase client (`supabaseAdmin.ts`), the
   same client every other admin-gated write path already uses.

3. Every query attempt (allowed or rejected) is logged to server logs with the
   staff email and the query text, for audit — no new table for this; existing
   log output is sufficient at this scale.

**UI**: session-only (chat history resets on page reload — no new table),
non-streaming request/response, matching every other route in this app (nothing
streams today).

## 4. Access control

Both the page and the chat route require role `ops` or `admin` — visibility of
business-wide numbers (including money-adjacent ones like payout aggregates) is
treated the same as Trust tiers / External ops / Jobs, not opened to `finance` or
`read_only`.

## 5. Non-goals (this spec)

- Migrating the existing direct-Anthropic call sites (`lib/photoVerify/claude.ts` —
  the payout-release gate — and `app/api/florists/draft-email/route.ts`) to
  OpenRouter. Real risk (financial gate, model-quality/latency/cost change) that
  deserves its own spec and verification pass, not a silent bundle into a
  statistics feature.
- Chat history persistence.
- Materialized views / pre-aggregation. At this data volume, on-the-fly queries are
  fast enough; revisit if the page gets slow.
- PostHog integration (session-replay-derived usage stats). Everything here comes
  from Supabase so the SQL chat can reason over all of it uniformly.
