# Semi-automatic loop — every transition previewed for CX approval

## Goal

Extend the existing `workflow_mode="semi"` from gating **one** step (the florist offer
email) to gating **every system-initiated transition**, each surfaced as a **rendered
preview** the CX team approves (or edits / rejects) before it fires. The point: run the
order loop semi-automatically and *see the exact outcome before anything goes to anyone*.

This is a generalization of machinery that already exists (`order_approvals`,
`approveOfferApproval`/`skipOfferApproval`, `ApprovalPanel`, the `semi` branch of
`advanceWaves`), not a green-field system.

## What "every transition" means (the honest boundary)

We gate every **system-initiated** transition. The **florist's own** actions — accept,
mark in-production, upload the delivery photo — are *inputs* we cannot hold behind CX
approval without breaking their app. What CX approves is the **system's response** to
those inputs. Concretely, in `semi` mode these become previewed approvals:

| kind | source today | preview | approve / reject |
|---|---|---|---|
| `match` | worker workflow | ranked candidate list | approve → `received→matched`; reject → `escalated` |
| `offer` *(exists)* | `advanceWaves` | offer email (rendered) | approve/edit body/skip candidate |
| `reassign` | `advanceWaves` (accept-SLA) | next candidate promoted | approve → `reassignOrder`; reject → leave |
| `escalate` | worker + `advanceWaves` | why it's escalating | approve → `escalated`; reject → leave |
| `writeback` | routes | Shopify metafield/note diff | approve → `writeBackStatus`; reject → skip |
| `client_assigned` / `client_on_the_way` / `client_delivered` | routes | the real customer email (rendered iframe) | approve/edit/skip |
| **held payout** (70% + 30%) | `payout.ts` hold gate | florist, €amount, card (+ proof photo/AI verdict for 30%) | **existing** `releaseHeldPayout` / `rejectHeldPayout` |

**Money stays on its existing hold mechanism** — safer than rerouting money through
`order_approvals`. Change: the **70% accept leg now also holds in `semi`** (the 30%
delivery leg already holds in any non-`auto` mode). The cockpit and order page **merge**
held payouts into the same approvals view so the UX is uniform, but the data path and the
release/reject routes are untouched.

## Architecture

### One effect-gate seam

`dashboard/lib/effectGate.ts` — every gated producer flows through:

```ts
gateEffect({ kind, orderId, assignmentId?, dedupeKey, preview, payload,
             draftSubject?, draftBody?, execute })
  ├─ mode ≠ semi → return { pending:false, result: await execute() }   // today's behavior
  └─ mode = semi → CAS-insert a pending order_approvals row (deduped on dedupeKey),
                    return { pending:true }                             // nothing fires
```

`execute` runs the real function inline in manual/auto. In semi we don't run it; we store
`payload` and let the executor reconstruct the call on approve. `currentWorkflowMode()`
reads `app_settings.workflow_mode` (default `"manual"`).

Per-effect wrappers keep call-sites clean: `gateClientEmail(orderId, kind)`,
`gateWriteback(shopifyOrderId, state, extra)`. Offer/match/escalate/reassign are filed by
`advanceWaves` / the worker directly (they already own that control flow).

### One executor

`dashboard/lib/approvalExecutors.ts` — `executeApproval(approval)` dispatches by `kind`
back to the *same* idempotent functions:

- `match` → CAS `orders.status` `received→matched`
- `escalate` → CAS `→escalated`
- `reassign` → `reassignOrder(orderId, actor)`
- `offer` → `sendOffer(assignmentId, actor)` (edits applied first — existing path)
- `writeback` → `writeBackStatus(shopifyOrderId, state, extra)`
- `client_*` → `deliverClientEmail(orderId, kind, edits)` (extracted from `notifyClient`)

`approve(approvalId, actor, edits?)` / `reject(approvalId, actor, reason)` generalize
`approveOfferApproval` / `skipOfferApproval`: CAS-claim the approval (`.eq('status','pending')`),
run the executor, roll back to pending on a retryable failure. `reject` marks
`skipped`/`rejected` and runs the per-kind reject side-effect (offer→expire candidate,
match→escalate, client_*→log skip, others→leave).

### `order_approvals` generalized (migration `2026-07-26-approvals-every-step.sql`)

- widen `kind` check to all kinds above
- add `preview jsonb`, `payload jsonb`, `dedupe_key text`
- **swap** the unique index `(order_id) where status='pending'` →
  `(dedupe_key) where status='pending'` (an order now legitimately has several pending
  approvals; each *effect* is unique). `23505` on insert = another tick filed it = benign.
- RLS unchanged (allow-listed read; service write).

### `notifyClient` refactor

Split into a pure-ish builder + a sender so the preview is the exact HTML that sends:

- `buildClientEmail(admin, orderId, kind) → { to, subject, html, testMode } | { skip: reason }`
- `deliverClientEmail(orderId, kind, edits?)` — the current claim-first-then-send body,
  using edited subject/body when present; re-renders (fresh signed proof URL) at send time.
- `notifyClient` in non-semi = build + deliver (unchanged behavior).

### Worker (`ingest-worker/src/orderWorkflow.ts`)

Read `workflow_mode` (mirror the `active_order_tags` step; worker is a separate build, so
the mode string is inlined, not imported). Candidates are **always** written (internal,
contacts no one). Then:

- `semi`: leave `orders.status='received'`, insert an `order_approvals` row —
  `kind='match'` (preview = candidates) if any, else `kind='escalate'`.
- otherwise: `setOrderStatus(matched|escalated)` as today.

### UI

- **`ApprovalPanel.tsx`** generalized to switch on `kind`: renders a per-kind preview
  (email → `<iframe sandbox="" srcDoc>`; payout → amount/card/photo card; match → candidate
  list; writeback → field diff; escalate/reassign → reason) with Approve / Edit (emails
  only) / Reject.
- **Order page** already passes all pending `order_approvals`; add a merge of this order's
  **held payouts** so both render in the panel.
- **Cockpit**: a "Pending approvals" section on `/cx` grouping every pending approval +
  held payout across orders, each with its preview. `cxAttention` already emits
  `category:"approval"` for offer approvals + `"money"` for held payouts — generalize the
  approval emit to all kinds so the sidebar badge + urgency stay correct.

### `lib/lifecycle.ts`

Update in the same change (repo rule): the reach-out automation-mode note generalizes to
"semi gates every step"; flip the relevant per-stage notes to reflect match/escalate/
client-email/writeback gating.

## Cross-cutting invariants (unchanged)

- Every `orders.status` write is compare-and-set.
- Executors are idempotent (payout INSERT-first, `client_comms` claim, `sendOffer` CAS).
- Filing dedupes via `dedupe_key` partial-unique; `23505` is benign.
- `test_mode` is orthogonal: an approved email still routes to the test sink if test-mode
  is on. Approval = human sign-off; test-mode = where the mail lands.

## Verification

- Unit (`node --test`): `gateEffect` files in semi / executes otherwise; dedupe; each
  executor idempotent; reject side-effects per kind.
- `tsc` clean, existing suite green.
- Manual: set `workflow_mode='semi'`, walk an order through match→offer→accept→
  in-production→delivered and confirm each step files a preview that fires only on approve;
  confirm the 70% + 30% both hold; confirm reject/edit paths.
- `code-reviewer` pass (money-hold change, CAS, dedupe, RLS, worker mode read).
