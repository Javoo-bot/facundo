# Communications hub — unified log, email quality, backoffice UX

**Date:** 2026-07-24 · **Status:** approved (directional), executing on `feat/communications-hub` (off staging)

## Problem

Every outbound message already flows through one Resend wrapper (`lib/email.ts::sendEmail`)
and web-push (`lib/push.ts`), and each send is logged to `external_ops`. But:

1. **No single place shows every message with its content.** Visibility is fragmented across
   5 surfaces — external-ops (metadata only, even omits the stored subject), the order
   timeline (labels only), issue threads (content, but issues-only per order), the CRM
   timeline (content, recruiting-only), the florist PWA (issues-only). Client email bodies
   are **never stored**; push notifications are **never logged**.
2. **Email quality is thin** — plain body strings, unverified `onboarding@resend.dev` from,
   and no "on the way" customer message (only `assigned` + `delivered`).
3. **Backoffice UX** has grown surface-by-surface and wants a coherence pass.

Real customer/florist mail is **off by default** (`app_settings.test_mode` defaults true →
all mail routes to a test sink, fails closed). This work stays **entirely in test-mode** —
no real customer mail is sent.

## Decisions (locked)

- **New `communications` table** as the single backbone (not extending `external_ops`).
- **Email = quality + audit in test-mode**: branded HTML template, add "on the way" notice,
  persist bodies, Settings "send test email" button. **No** verified sending domain this pass.
- **UX = broader backoffice pass** (beyond just the comms surfaces), scoped to what fits.

## Workstream A — Communications backbone (critical path)

**Migration `supabase/migrations/2026-07-24-communications.sql`** — `communications`:

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `created_at` | timestamptz default now() | |
| `channel` | text check (`email`,`push`) | |
| `audience` | text check (`florist`,`client`,`cx`,`staff`) | who it's to |
| `kind` | text | `offer`, `offer_push`, `client_assigned`, `client_on_the_way`, `client_delivered`, `cx_alert`, `cx_alert_push`, `issue_to_cx`, `issue_to_florist`, `issue_push`, `recruiting`, `test` |
| `order_id` | uuid null → orders | |
| `florist_id` | uuid null → florists | |
| `assignment_id` | uuid null | |
| `issue_id` | uuid null | |
| `to_address` | text null | email address or masked push endpoint |
| `subject` | text null | null for push |
| `body` | text null | **the actual content** — the gap we're closing |
| `test_mode` | boolean not null | was it routed to the sink |
| `status` | text check (`sent`,`failed`,`skipped`) | |
| `provider` | text | `resend` \| `web-push` |
| `provider_message_id` | text null | |
| `error` | text null | |
| `actor` | text null | who triggered it (email/system) |

Index `(order_id, created_at desc)`, `(created_at desc)`. RLS: staff-read via
`is_email_allowed()`, florist scoped read on `florist_id = current_florist_id()`,
service-role write. (Copy the phase0 RLS block.)

**Capture helper `lib/communications.ts::logCommunication(row)`** — one insert via the service
client, never throws (a logging failure must not break a send). 

**Wire it into every send site.** `sendEmail()` already accepts a `context` param + logs to
external_ops; extend `context` to carry `{channel,audience,kind,order_id,florist_id,
assignment_id,issue_id,actor}` and have `sendEmail` **also** write a `communications` row with
the resolved `to`, `subject`, `body`, `test_mode`, `status`. Do the same for `sendPushToFlorist`
/ `sendPushToStaff` in `push.ts` (channel `push`, no subject). Callers to pass context:
`reachoutSend.ts`, `clientComms.ts`, `issueComms.ts`, `cxAlerts.ts`, `outreach/send/route.ts`.
`external_ops` logging stays as-is (call audit); `communications` is the message-shaped view.

## Workstream B — Unified view + per-order + per-florist

- **`/communications` (SYSTEM sidebar)** — server-fetched timeline of `communications`,
  newest first, filterable by **channel / audience / status / real-vs-test**, plus a text
  search over subject/body/recipient. Each row expands to show full subject + body; links to
  the order/florist. Reuse the design-system table + filter-popover patterns from the orders
  page. Reasonable page size (e.g. 200) with a "load more".
- **Per-order "Communications" section** on `OrderDetailClient` — every `communications` row
  for that order (email + push, all audiences) with content on click. Sits alongside the
  existing event log (events = state changes; communications = messages).
- **Per-florist** — a compact communications list on the florist detail page (their offers +
  issue mail). Nice-to-have; do if time.

## Workstream C — Email quality (test-mode)

- **`lib/emailTemplate.ts`** — one shared branded HTML layout (logo/wordmark header, content
  slot, footer with "Facundo · automated message"). Wrap the existing plain bodies; keep a
  plain-text fallback. Apply to florist offers, client notices, CX alerts, issue mail.
- **"On the way" customer notice** — add `COPY.on_the_way` and fire `notifyClient(order,
  "on_the_way")` when status → `out_for_delivery` (in the status route). Extend the
  `client_comms` unique-kind idempotency to the new kind.
- **Persist client bodies** — falls out of Workstream A (client emails now land in
  `communications.body`); no change to `client_comms` needed beyond it staying the idempotency
  claim.
- **Settings → "Send test email"** — a button in External services that POSTs to a new staff
  route; sends a sample branded email to `test_email` via `sendEmail` and reports ok/error, so
  deliverability is verifiable without waiting for a live order.

## Workstream D — Backoffice UX pass

A `product-ui-designer` brief (read-only) proposes a prioritized, quick-win list across the
backoffice (nav/IA, the new comms surfaces, orders/florists/settings density, empty/error
states, email visual polish). We pick what fits today; `frontend-engineer` applies. Scoped so
it doesn't balloon — anything large is logged as follow-up, not started.

## Sequence

1. **A** (migration + `logCommunication` + wire all send sites) — critical path.
2. **C** in parallel once A's helper exists (template + on-the-way + test-send button).
3. **B** after A (view + per-order section).
4. **D** designer brief runs in parallel from the start (read-only); apply after B.

## Order-loop touch → lifecycle map

Adding the "on the way" customer notice touches the settle/write-back client-comms path.
Update `dashboard/lib/lifecycle.ts` in the same PR (the `writeback`/`delivered` client-comms
notes; note the new `on_the_way` notification).

## Verification

- Migration applies; RLS: staff read all, florist reads only their own, anon reads nothing.
- `logCommunication` records a row for each send type (unit-test the pure row-builder;
  integration-check one email + one push land in `communications`).
- `/communications` renders, filters work, content is viewable, order/florist links resolve.
- Per-order section shows that order's messages only.
- "Send test email" delivers to the sink and reports status; branded template renders in a
  real client.
- No real customer mail sent (test_mode stays on).
- `tsc` + lint + build clean; full test suite green. Browser-exercise the new surfaces.
- End with a `code-reviewer` pass (RLS on `communications`, no body/PII leak to florist scope,
  send paths still fail-closed).
