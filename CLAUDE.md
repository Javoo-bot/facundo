# Facundo

Grew from a two-day florist-discovery POC into two working, connected systems: find
and sign up florist shops, then run real Shopify orders through them for a live 70/30
payout split. Both live in this one repo. **The system separation in the section
below is load-bearing** — read it before adding anything, because which side a change
belongs on changes what "correct" means for it.

## Authoritative documents

- `facundo-poc-brief.md` — the original brief (data model, scoring
  algorithm, auth flow). Still correct for the Discovery/Recruiting scoring math;
  everything about production order handling postdates it.
- `docs/superpowers/specs/2026-07-01-facundo-poc-design.md` — the original build
  plan and corrections to the brief.
- `docs/superpowers/specs/` more broadly — every non-trivial feature since has its
  own dated design doc there (order working set, Airwallex payouts, staff roles,
  florist multi-user, the unified CX desk, semi-auto approvals, and more). When
  changing behavior in an area, check for a design doc with that name before
  guessing at intent from the code alone.
- `/lifecycle` (see below) is the living map of the production order loop —
  prefer it over any design doc for "what's the current state of the order loop."

## Two systems, one repo

Facundo is **two products sharing infrastructure**, not one pipeline. Keep them
conceptually separate when adding features, writing copy, or deciding where new code
belongs — conflating them is exactly the kind of thing that makes both harder to reason
about.

1. **Discovery & Recruiting** — finding florist shops, scoring/ranking them, enriching
   their contact details, running outreach funnels and personas, join links,
   onboarding / profile completion, and recruiting analytics. This is a sales/growth
   funnel whose "customer" is the florist shop we're trying to sign. Lives mostly in
   `ingest/` (scrape + enrich), `dashboard/`'s recruiting UI (outreach, sequences,
   personas, join flow), and the `kind='recruiting'` half of `conversations`
   (`dashboard/lib/cxAgent.ts`, guarded by `dashboard/lib/cxAgentGuard.ts`).
2. **Production / Order Operations** — taking a real Shopify order, matching it to a
   florist, running the offer wave, paying the 70/30 split against a delivered photo,
   handling florist questions/support, writing the result back to Shopify, and
   escalating to a human when a step fails. This is operations whose "customer" is the
   end recipient of the flowers. Lives mostly in `ingest-worker/` (the Cloudflare
   Worker that owns the Shopify webhook, matching, offer waves, and reconciliation),
   `dashboard/`'s order/backoffice UI, Airwallex payouts (`dashboard/lib/airwallex/`),
   and the `kind='support'` half of `conversations`.
   - **Sending an order to a shop that hasn't finished onboarding yet (a "cold
     offer") is still Production/order-handling, not Recruiting** — it's a matching
     policy decision (see the `reachout-cold-offer` branch on `/lifecycle`), even
     though the shop on the other end is mid-recruiting-funnel.

The order-lifecycle map at `/lifecycle` treats the recruiting funnel as the "supply"
phase that feeds Production's "intake" phase — they're sequential, not merged; a
prospect becomes a Production concern only once an order is actually being routed to
them.

### The working-set boundary

Shopify orders **arrive continuously and are not automatically worked**. Passive
intake (a webhook lands, the row is created) is a different thing from active
automation (matching, offer waves, reoffers) touching that order — the two are
deliberately decoupled:

- Staff/policy define a **working set** — via `app_settings.active_order_tags`
  (standing tag gate) and/or explicit `orders.worklist_at` picks.
- `isInWorkingSet()` (duplicated identically in `dashboard/lib/workingSet.ts` and
  `ingest-worker/src/workingSet.ts` — `lib/workingSet.test.mjs` asserts they haven't
  drifted) is the single gate every piece of automation checks before acting on an
  order. Gate off (no tags, no picks) = the pre-gate default: every order is worked,
  same as before the gate existed.
- An order outside the working set is still ingested, still visible in the full
  orders list — it's just never auto-matched, auto-offered, or auto-escalated. It sits
  there until staff explicitly pick it or it matches an active tag.
- See `docs/superpowers/specs/2026-08-11-order-working-set-and-perf-design.md` for the
  full semantics table and the failure mode (2026-08-04) that motivated the gate.

If you're writing anything that touches orders in bulk — a new sweep, a cron job, a
reconciliation pass — it almost certainly needs to check the working set before
acting, not just before displaying.

## Structure

- `ingest/` — Python 3.11+ CLI pipeline (`uv` for env management), Discovery/Recruiting
  side. Scrapes Apify, enriches with `httpx` + `beautifulsoup4` + Claude, writes to
  Supabase.
- `ingest-worker/` — Cloudflare Worker (TypeScript), Production/Order Operations side.
  Owns the Shopify webhook, matching, offer waves, reconciliation sweeps, and
  Claude calls for the order loop (via OpenRouter — see below). Deployed by
  `.github/workflows/deploy-ingest-worker.yml`.
- `dashboard/` — Next.js 15 (App Router) + React 19 + TypeScript, serves **both**
  systems: staff backoffice (orders, CX desk, `/lifecycle`, settings), the florist
  portal (join, profile, order accept/support), and the original recruiting map/
  scoring UI. Google + email/password auth via Supabase, RLS-enforced allow list.
- `supabase/schema.sql` + `supabase/migrations/` — schema for both systems: the
  original `cities`/`florists` discovery tables, plus `orders`, `order_assignments`,
  `payouts`, `conversations`, `order_approvals`, and more for production.

## Keep the order-lifecycle map current

`/lifecycle` (staff sidebar → SYSTEM → **Order lifecycle**) is the shared visual map of the
Production order loop: the happy path (Shopify order → working-set selection → matched
florist → offer wave → accept/70% → photo/30% → written back to Shopify), every failure
branch we've thought of + how it's handled, and per-node build status. It exists so the team can see at a glance what's built,
what's next, and where things can still break. It is rendered **entirely from
`dashboard/lib/lifecycle.ts`** — that one file is the single source of truth (no backend).

**On any order-loop work, update `lib/lifecycle.ts` in the same change — treat it like a test
you keep green.** Specifically:

- Shipped a stage or a branch's handling → bump its `status` (`planned`/`in-progress` →
  `shipped`, or a branch to `handled`).
- Found a new way it can break → add a `Branch` on the affected stage (or a `CROSS_CUTTING`
  entry if it can fire anywhere), with its handling. Use status `open` when we haven't settled
  a handling yet — that's what surfaces it in the page's "help wanted" roll-up for the team.
- Moved or renamed the implementing code → fix that stage's `code` refs.

If a change touches the order loop and you did *not* touch `lib/lifecycle.ts`, say why.

## Conventions that matter

- **The ingest worker calls Claude through OpenRouter**, not the Anthropic API —
  one key for the whole repo (photo verify and stats chat were already there), and
  the Anthropic account running dry is what silently disabled every LLM leg of the
  pipeline on 2026-08-06. Model slugs are `anthropic/claude-sonnet-5` and
  `anthropic/claude-haiku-4.5` — note the **dot** in the Haiku slug; OpenRouter's
  spelling differs from Anthropic's `claude-haiku-4-5`. Transport, timeout and
  retry live in `ingest-worker/src/openrouter.ts`.
- **Claude models: `claude-sonnet-5` (default) + `claude-haiku-4-5` (cheap picks).**
  Do NOT use `claude-sonnet-4-6` (the brief's outdated ID). Per-call-type routing lives
  in `ingest/usage.py::MODEL_FOR_CALL`: only ecommerce classification (is-this-a-store
  judgment) uses Sonnet-5; phone + email *selection* (picking the genuine primary from an
  already-extracted candidate list — mechanical) AND owner-name extraction use Haiku 4.5.
  This was a measured decision (Girona baseline: phone+email were ~48% of LLM cost;
  swapping them cut LLM cost ~40% with no quality regression). owner-name was later moved
  to Haiku too after a spot-check showed 6/6 owner_name agreement with Sonnet across the
  judgment edge cases (real owner vs brand-only / staff / testimonial, es/en/de), including
  no over-extraction on the null cases — halving that call's cost (Haiku is exactly ½ the
  Sonnet token rate). Cost per run is tracked in `ingest_jobs` (`llm_cost_by_type`) and
  shown on the dashboard `/jobs` page.
- **LLM calls use forced tool-calling for structured output.** (The worker never
  used `output_config.format` / `messages.parse()` — it forces a single tool whose
  parameter schema IS the target shape and reads the arguments back. That port
  cleanly to OpenRouter's OpenAI-compatible shape is why this migration was
  mechanical.) One trap: OpenAI-shaped APIs return `tool_calls[0].function.arguments`
  as a **JSON string**, where Anthropic returned `tool_use.input` already parsed —
  `llm.ts::structured` parses it. No `temperature`/`top_p`, no assistant prefills.
- **Enrichment fields are nullable and honest.** When a field is genuinely unknown,
  store `null` and record why in `enrichment_notes`. Never fabricate a value.
- **Scoring/spread math guards nulls.** `rating`, `lat`, `lng`, `review_count`,
  `distance_km_from_center` can all be null — guard before arithmetic (a null must not
  produce `NaN`).
- **Ingest is idempotent.** Upsert on `(city_id, place_id)`. Re-running the CLI on the
  same city updates rather than duplicates.
- **Ingest uses the Supabase service-role key** (writes, bypasses RLS). The dashboard
  uses the anon key + user JWT via `@supabase/ssr` cookies (RLS enforces
  `authenticated`).
- The dashboard also holds `SUPABASE_SERVICE_ROLE_KEY` (server-only) for a narrow set of
  auth-gated server-side reads/writes — florist exclude (`/api/florists/exclude`),
  outreach records, and allow-list management (`/api/allowlist`, `lib/allowlist.ts`) —
  via `lib/supabaseAdmin.ts::createServiceClient`. All other *reads* stay on the anon
  key + JWT under RLS.
- **Auth is an allow list, enforced in RLS + the app, with the `allowed_emails` table as
  the single runtime source of truth.** RLS policies check `auth.jwt()->>'email'`
  against it via `is_email_allowed()`, so read access holds even if a session is
  obtained outside the app (the anon key is public). The same table is also read at
  runtime by `lib/allowlist.ts::isAllowed` (server-only, fail-closed — any DB error or
  exception denies access) for the OAuth-callback bounce and every server-side gate, so
  edits made from the `/settings` page's "Authorized emails" UI take effect immediately
  for both RLS and app-level checks. `ALLOWED_EMAILS` (server-side only, never
  `NEXT_PUBLIC_`) is now **seed-only** — it is not read at runtime; it's just a
  convenience for seeding the table on first setup (see `supabase/schema.sql`). Google
  OAuth and email/password sign-in are both supported. Self-registration
  (`/auth/register` → `POST /api/auth/register`) is public but gated on
  `isAllowed(submittedEmail)` — only allow-listed emails can create an account, via a
  service-role `auth.admin.createUser` call with `email_confirm: true` (no verification
  email). Password reset (`/auth/forgot` → `/auth/callback?next=/auth/reset` →
  `/auth/reset`) reuses the same OAuth callback route's code exchange and allow-list
  gate before letting the user set a new password.
- **Nominatim** (geocoding) needs a custom `user_agent` and ≤1 request/sec.
- **Error capture is centralized. The chosen observability sink is PostHog, not
  Sentry.** `dashboard/lib/monitor.ts` and `ingest-worker/src/monitor.ts`
  (deliberately duplicated, one per build) give every call site one
  `captureError(context, err)` entry point, which emits a structured
  `console.error` payload by default and can take a `setErrorSink()` override
  later without touching call sites. If a registered sink itself throws,
  `captureError` falls back to the default console payload rather than losing
  the original error — don't "simplify" that away. **The worker side is wired
  up**: `ingest-worker/src/analytics.ts` POSTs order-automation events straight
  to PostHog's HTTP capture endpoint (no Node SDK — env-gated on
  `POSTHOG_PROJECT_TOKEN`/`POSTHOG_HOST`, no-ops when unset) and
  `installAutomationErrorSink()` registers a `setErrorSink()` sink from each
  Worker entry point (`fetch`/`scheduled`/`queue` in `index.ts`) that MIRRORS
  (never replaces) the console payload, additionally forwarding contexts on its
  order-automation allowlist (`webhook.*`, `reconcile.*`, a few `cron.*` ones —
  see `ORDER_AUTOMATION_CONTEXT_PREFIXES`) as an `order_automation_failed`
  event. `orderWorkflow.ts` and `lateMatch.ts::matchAndWriteCandidates` also
  emit `order_workflow_step_failed` / `order_match_failed` directly for their
  own high-value failure paths. **The dashboard side is not yet wired** — see
  the `TODO(ops)` comment in `dashboard/lib/monitor.ts` for what's missing (a
  server-side Next.js entry point to register the sink from).
- **CX attention is centralized, not scattered.** `dashboard/lib/cxAttention.ts`
  (`gatherAttention`) is the one place that gathers everything needing a human across
  the Production order loop — unplaceable orders, stalling offers, pending
  approvals, florist issues/unread messages, late deliveries, held/failed payouts,
  disputes, Shopify conflicts, and escalated support conversations — into one
  prioritized per-order list, gated by the working set. Both the CX desk table and
  the sidebar badge count read this same function so they can never disagree. New
  "something needs a human" surfaces belong here, not as a one-off badge elsewhere.
  Recruiting-side (`kind='recruiting'`) conversation escalations are intentionally
  out of scope for this file — it's Production-only; see `/conversations` for the
  unified (recruiting + support) conversation list in the meantime.
- **The order-loop demo sandbox (`/testing`, admin-only) is a second, separate
  harness from the Recruiting-side "test stores" panel on the same page.**
  `dashboard/lib/testing/demoSandbox.ts` creates a demo shop
  (`florists.is_test_shop=true`, `place_id` prefixed `DEMOKIT_`) and a demo order
  (`orders.is_demo=true`, optionally cloned from a real order via
  `demo_source_order_id` — product/price data only, buyer/recipient PII is never
  copied) and drives it through one of `lib/testing/orderScenarios.ts`'s six
  Production/order-loop presets (nearby-shop happy path, no-nearby-shop
  escalation, offer-timeout, accepted-awaiting-photo, paid, held-for-review)
  using the REAL `matchFlorists`/`sendOffer`/`payoutOnAccept`/`payoutOnDelivered`
  functions — never a mocked send. Three safety properties hold regardless of any
  other setting: (1) a demo shop's email/phone are always
  `app_settings.test_email`/`test_phone`, set at creation, and creation is
  blocked if `test_email` is unset (`lib/testing/demoSink.ts`); (2) demo matching
  never reads or writes the global `app_settings.test_shop_matching` toggle — it
  queries only `is_test_shop` florists and passes `testShopMatching: 'only'` as a
  per-call argument, so it can never affect a real order's matching; (3)
  `lib/payout.ts` forces the ledger rail (`effectivePaymentsLive` in
  `lib/payoutMath.ts`) for a `/testing` demo-sandbox order's payout leg
  regardless of `app_settings.payments_live` or any other flag — a demo shop can
  never receive a real Airwallex card, full stop. Demo orders are never added to
  the working set, so real automation never touches them. **This absolute
  guarantee is narrower than the general `is_test_shop` guard**: for an ordinary
  (non-demo, `orders.is_demo=false`) order assigned to an `is_test_shop`
  florist — e.g. a manual QA run through the staff mock-order tool — the ledger
  rail is still the default, but staff can deliberately opt in to a real
  **sandbox** card via `AIRWALLEX_ALLOW_DEMO_LIVE=1` on the Airwallex demo base
  (`railGate.ts::testShopLiveAllowed`); it is refused unconditionally on a
  production base regardless of the flag, and refused unconditionally for any
  `/testing` demo-sandbox order regardless of the flag.

## Commands

```bash
# Discovery/Recruiting: ingest one city
cd ingest && uv sync && uv run python main.py --country US --city Boston

# Production: the order-loop worker (Cloudflare Worker)
cd ingest-worker && npm install && npm run dev        # wrangler dev
cd ingest-worker && npm run typecheck && npm test      # tsc --noEmit + vitest

# Dashboard (serves both systems)
cd dashboard && npm install && npm run dev   # http://localhost:3001
cd dashboard && npx tsc --noEmit && npm test # typecheck + node --test over lib/**/*.test.mjs
```

Supabase setup (once): run `supabase/schema.sql` then everything in
`supabase/migrations/` in date order, enable the Google auth provider, and set the
OAuth redirect + `ALLOWED_EMAILS`. Details in `README.md`.

## Writing back to Shopify — use the `shopify-flow` skill

Any work that writes to a Shopify order (fulfilment status, shipment events,
order email, tags, notes, metafields) — or any test of that path — should start
by invoking the **`shopify-flow`** skill (`.claude/skills/shopify-flow/`). It
carries the things that are expensive to rediscover, including two traps that
send you looking in the wrong place entirely:

- the scope that actually gates fulfilment writes is
  `write_merchant_managed_fulfillment_orders`, NOT `write_fulfillments` — and the
  failure presents as `"The api_client does not have access to the fulfillment
  order"`, which reads like a bad token;
- **`notifyCustomer: false` does NOT prevent customer email on this store.**
  Customer mail is sent by Mechanic tasks reacting to `orders/updated` and
  pushing to Ongage, an architecture that never sees that flag;
- `.env` names the credentials `DOMAIN` / `ADMIN_TOKEN_SHOPIFY`, not the
  `SHOPIFY_*` names the code reads;
- how to pick an order genuinely safe to practise on, and the staged
  swap/write/restore harness (`dashboard/scripts/fulfilment-test-run.mjs`) that
  proves a write without risking a live customer.

## Verification

- **Discovery/Recruiting ingest:** run the CLI against a real city; confirm 50–150
  rows land in Supabase with enrichment populated (nullable where unknown); re-run and
  confirm the count is stable.
- **Production worker:** `cd ingest-worker && npm run typecheck && npm test`. Changes
  touching the order loop should also be checked against `/lifecycle` — does the map
  still describe reality?
- **Dashboard:** exercise it in a real browser (chrome-devtools-mcp is available).
  Confirm no florist/order data leaks in the network tab when signed out, allow-list
  enforcement works both ways, recruiting slider changes re-rank within a frame, and
  (for order-loop changes) the working-set gate actually excludes what it should.
- Don't claim a phase works without running it.

## Non-goals (do not build)

This list drifts fast — if something below turns out to already exist, fix the list
rather than trusting it. Currently true:

- No auth provider beyond Google OAuth + Supabase email/password.
- No admin UI beyond the dashboard itself.
- No live end-to-end test harness that boots the dashboard and the worker together
  against a real Supabase project and drives an order through the full loop.
  `ingest-worker/test/e2e/orderLoop.e2e.test.ts` closes part of that gap: it drives the
  REAL intake→working-set-gate→match modules (`parseShopifyOrder`, `isInWorkingSet`,
  `matchAndWriteCandidates`, `matchFlorists`, plus the dashboard's pure payout-math/
  hold-decision/tag-union/status-machine functions) against real state transitions in
  an in-memory fake Supabase, including a negative (no-match → `escalated`) case — see
  that file's header for the exact real-vs-simulated boundary. Still not built: nothing
  boots a real Postgres, the Cloudflare Workflow runtime, or the alias-heavy
  dashboard-side pieces (the offer-wave cron, real Airwallex issuance, the real Shopify
  writeback HTTP calls, `cxAttention.ts`) — that file's header ends with the concrete
  next step (a scoped vitest alias + a handful of `vi.mock`s) to close the rest.
  `dashboard/lib/orderLoopContract.test.mjs` remains as a separate, narrower guard that
  `lib/lifecycle.ts` hasn't drifted from the stages/files it claims exist.
- No dashboard-side monitoring/error-tracking sink wired up yet — `captureError()`
  there has no sink registered (see the Conventions section above; the
  ingest-worker side IS wired to PostHog).
- No full order-automation-health dashboard/alerting built on top of the
  PostHog events yet — `order_automation_failed` / `order_match_failed` /
  `order_workflow_step_failed` are emitted (see the Conventions section above)
  but nothing in PostHog itself (an insight, an alert) consumes them yet.

No longer true, do not assume otherwise: staff roles (admin/ops/finance/read_only)
and florist-facing multi-user access both shipped (see
`docs/superpowers/specs/2026-07-21-staff-roles-design.md` and
`2026-07-21-florist-multi-user-design.md`); real outreach email (Ongage transactional API) and SMS
(Telnyx) sending both exist (`dashboard/lib/email.ts`, `dashboard/lib/sms.ts`); CI and
deploy automation exist (`.github/workflows/`); test coverage is now over a thousand
`node --test`/`vitest` cases, not "one or two sanity assertions."
