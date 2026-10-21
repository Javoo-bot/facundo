# Airwallex Module v2 — Design

**Goal:** grow the payout integration from "issue a single-use card" into a real money loop —
the florist can *use* the card, the ledger reflects what actually happened, exposure is bounded,
and staff can jump straight to Airwallex. SEPA/FX and full dispute-raising are deferred to
frontend placeholders.

## Scope

- **Phase 1 — Foundation + deep-links.** Shared client (token cache + retrying fetch, GET+POST) and
  an `airwallexUrl()` console deep-link builder. Refactor `lib/airwallex.ts` → `lib/airwallex/`.
- **Phase 2 — Reveal card.** Retrieve sensitive PAN/CVV/expiry via Airwallex's secure endpoint,
  behind an auth-gated, ownership-checked route + a florist "reveal" UX.
- **Phase 3 — Webhooks.** Signature-verified receiver → move payouts `issued → paid`, record spend,
  flag declines / expiry, and ingest dispute status.
- **Phase 4 — Risk.** Cancel the live card on clawback, add MCC/currency card controls, a wallet
  low-funds guard before issuing, and a dispute deep-link.
- **Deferred (frontend placeholder only):** SEPA/bank-transfer rail + FX; full programmatic
  dispute-raising (surfaced via deep-link for now).

## Architecture — `dashboard/lib/airwallex/`

Pure, dependency-light **leaf modules** (unit-tested directly under `npm test`):

- `retry.ts` — `retryingFetch(url, init, {fetchImpl, sleep, attempts})`: retries network errors + 429/5xx
  with capped exponential backoff. `fetchImpl`/`sleep` injectable for tests.
- `links.ts` — `airwallexUrl(kind, id)` for `card | transaction | dispute`, sandbox-vs-prod via
  `AIRWALLEX_APP_BASE`. Null-safe.
- `webhookVerify.ts` — `verifyWebhook(rawBody, timestamp, signature, secret)`: HMAC-SHA256 hex of
  `timestamp + rawBody`, **timing-safe** compare, timestamp freshness window (replay guard).
- `controls.ts` — `buildAuthorizationControls({amountCents, currency, mccAllowlist})`: pure builder for
  the card's `authorization_controls` (SINGLE use + ALL_TIME limit + allowed currency + optional MCC).
- `funds.ts` — `hasSufficientFunds(balances, currency, amountCents)`: pure guard.
- `webhookMap.ts` — `mapWebhookEvent(event)`: pure event → `{ eventType, payoutPatch?, cardId?, txnId? }`.
- `revealGuard.ts` — `canRevealCard(payout, floristId)`: pure ownership/rail/provider-ref check.

**IO modules** (compose the above; integration-tested via sandbox smoke, not `npm test`):

- `client.ts` — `airwallexToken()` (**cached** until ~1 min before JWT `exp`), `awxGet`/`awxPost`
  (bearer-injected, via `retryingFetch`). One place for BASE + auth.
- `cards.ts` — `issueSingleUseCard(amountCents, currency, ref, opts?)`, `getCard(id)`,
  `getSensitiveCardDetails(id)`, `cancelCard(id)`.
- `balance.ts` — `getWalletBalances()`.
- `index.ts` — re-exports the public surface; keeps `issueSingleUseCard` import path stable for `rails.ts`.

## Data model — `payouts` additions (migration `2026-07-14-airwallex-v2.sql`)

`card_status text`, `expires_at timestamptz`, `spent_amount numeric`, `settled_at timestamptz`,
`dispute_status text`, `last_txn_id text`. New `airwallex_events(id text pk, type text, received_at)`
for **webhook idempotency** (dedupe by Airwallex event id); RLS allow-listed read. `payment_events`
(existing) stays the human audit trail.

## Data flow

1. **Issue** (`payout.ts` → `rails.CardRail` → `cards.issueSingleUseCard`): now funds-guarded
   (`balance.ts` + `funds.ts`) and control-scoped (`controls.ts`, MCC from `AIRWALLEX_ALLOWED_MCC`).
2. **Reveal** (`GET /api/florist/card/[payoutId]`): `currentFlorist()` → load payout+assignment →
   `canRevealCard` (owner + rail=card + real card_id) → `getSensitiveCardDetails` → return with
   `Cache-Control: no-store`. Writes a `card_revealed` `payment_events` row (**no** sensitive data).
3. **Webhook** (`POST /api/webhooks/airwallex`): read **raw** body → `verifyWebhook` (401 on fail) →
   dedupe in `airwallex_events` (200 if seen) → `mapWebhookEvent` → patch `payouts` + `payment_events`.
4. **Clawback** (`payout.ts::clawbackForOrder`): after the negative ledger row, `cancelCard` each live
   card for the clawed legs (best-effort, audited).

## Security

- **Never store or log** PAN/CVV/expiry. Reveal returns them once over TLS to the owning florist only;
  response is `no-store`; audit records only *that* a reveal happened.
- **Webhook**: verify signature on the raw body **before** parsing; timing-safe compare;
  reject stale timestamps (replay). Secret in `AIRWALLEX_WEBHOOK_SECRET` (server-only).
- **Reveal authorization**: `canRevealCard` enforces the florist owns the payout's assignment; a
  ledger-rail / cardless payout returns 409, a foreign payout 403.
- **Funds guard is fail-open on the *check*** (a balance-API hiccup must not block a real payout) but
  **fail-closed on a known-insufficient** balance (record + skip). Documented, not silent.
- All new secrets are server-only (never `NEXT_PUBLIC_`).

## Error handling

Payout issuance stays best-effort (never fails accept/delivery). Webhook handler is defensive: unknown
event types are recorded and 200'd, never 500. Card cancel / balance failures are logged
(`captureError`) + audited, never thrown to the caller.

## Testing (edge cases)

`npm test` (node --test, pure leaves): retry (success / retry-on-5xx / retry-on-network / exhaust /
no-retry-on-4xx), links (each kind, null id, demo vs prod), webhookVerify (valid / tampered body /
wrong secret / bad signature / stale timestamp), controls (with/without MCC, rounding), funds
(sufficient / insufficient / missing-currency / null balance), webhookMap (auth / settlement / decline /
expiry / dispute / unknown), revealGuard (owner ok / foreign 403 / ledger-rail 409 / cardless 409).
Integration smoke (tsx, sandbox): issue → getSensitiveCardDetails → cancelCard on a real sandbox card.

## Placeholders

FloristBalance: "Bank transfer (SEPA) — coming soon". PaymentsLedger: dispute deep-link where a
`dispute_status` exists; "raise dispute" is a link to Airwallex, not an in-app flow yet.
