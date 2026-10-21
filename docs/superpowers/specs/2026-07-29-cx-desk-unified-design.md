# Unified CX desk — one surface to see *and* act

**Status:** design note (exploration outcome, "explore first"). This captures an agreed
*direction*, not an implementation plan. It builds directly on the machinery in
[`2026-07-26-semi-auto-approvals-design.md`](./2026-07-26-semi-auto-approvals-design.md);
where that doc defines the *backend* (`order_approvals`, `gateEffect`, `executeApproval`,
`ApprovalPanel`), this defines the *information architecture* those pieces render into.

**Mockup:** [`assets/2026-07-29-cx-desk-mockup.html`](./assets/2026-07-29-cx-desk-mockup.html)
(not published). Fake data, wired
to nothing — a layout prop.

## Problem

Today there are two staff CX surfaces and the split is confusing:

- **`/cx`** (`gatherAttention` → `CxAttention`) — a prioritized, per-order list of
  everything needing a human (categories `place · approval · message · delivery · money`).
  It's **read-only triage**: every row just links to `/orders/{id}`. No inline action.
- **`/cx/approvals`** (`ApprovalPanel` + `HeldPayoutCard`) — the *only* surface where you
  can **act inline** (approve / reject / edit), but only for pending `order_approvals` +
  held payouts, and `order_approvals` only exist in `workflow_mode="semi"`.

So **see-everything lives in one place and do-something in another**, and the two overlap
(the desk already shows approvals as `category:"approval"` rows and held payouts as
`category:"money"` rows — but you can't act on them there). Staff feedback: *"confusing /
cluttered."* The goal picked: **merge triage + action into one clear surface.**

## The operating-model insight (this drives everything)

`semi` mode is **not the destination — it's the trust-building on-ramp to `auto`.** The
team runs semi now to watch the loop propose each step, approve it, and build confidence;
once confident, they switch to automatic. Two consequences:

1. **The desk is permanent; the approvals layer is transitional.** At `auto`, the
   `approval`-category items vanish, but the exception signals (stalled offers, disputes,
   late deliveries, held payouts) remain. → Don't over-invest in a standalone approvals
   *cockpit* you're deliberately trying to make vestigial. **Fold it into the desk.**
2. **The approvals UI's real job is confidence, not throughput** — "verify the machine is
   right and earn the trust to stop watching." That's why the *agree-rate* (below) matters
   and why blind batch-approve is an anti-goal.

## Decisions (locked in this exploration)

1. **Unify.** Fold `/cx/approvals` into `/cx`. One worklist; the standalone approvals page
   goes away. Its one real advantage (edit-then-approve email drafts) survives as an inline
   drawer, so nothing is lost.
2. **Two zones, not one interleaved list.**
   - **Proposed by the system** (top) — the semi-mode approvals, as **cards**. Front and
     center because they're the daily ritual *now*; this zone empties as kinds graduate to
     auto.
   - **Needs a human** (below) — the permanent exception queue, as a dense **table** with a
     per-row primary action + severity stripe.
   Rationale: they're different *mental* objects ("the machine wants to do X → say yes" vs
   "the machine is stuck → fix it"). Interleaving purely by urgency (today's behavior) is
   what makes the current page feel cluttered.
3. **Cards for approvals, table for exceptions** — density matched to content weight.
   Approvals carry previews / drafts / agree-rate and need room; exceptions are scan-and-act.
4. **Inline drawer for email-draft approvals** (`offer`, `client_assigned`,
   `client_on_the_way`, `client_delivered`). Expand in place to edit subject/body and
   approve — no page bounce. This is what lets `/cx/approvals` be deleted.
5. **Per-row inline primary action** on the exception table, matched to the reason:
   `Advance ▸` (next florist), `Release ▸` (held payout), `Settle ▸` (failed payout),
   `Mark delivered`, `Open ▸` (florist issue). The row still click-throughs to the order.
6. **Category filter chips across both zones** — carried over from today's `CxCategory`
   set. Filtering to *Proposed* shows only the top lane; a specific category shows only
   matching exceptions.
7. **Agree-rate woven in, not built out.** Each approval card shows a small confidence chip
   ("approved 46/48 unchanged", "50/50 · ready for auto?", "edited 6 of 20"). This is a
   *teaser* of the confidence instrument — enough to hint per-kind graduation without
   committing to that surface here.

## How it maps to existing code (high level — not a build plan)

- **Data already exists.** `gatherAttention` (`lib/cxAttention.ts`) already emits the
  `approval` and `money` categories the two zones need; the
  [semi-auto-approvals doc](./2026-07-26-semi-auto-approvals-design.md) generalizes the
  approval emit to every kind. The desk consumes that same request-cached gather
  (`getAttentionCached`, see [`2026-07-29 perf work`](#relationship-to-other-work)).
- **`/cx` (`app/(staff)/cx/page.tsx` + `components/orders/CxAttention.tsx`)** grows the
  two-zone layout; `CxAttention` renders the exception table (mostly its behavior today) +
  hosts the Proposed lane.
- **`ApprovalPanel.tsx`** (generalized per the semi-auto doc) is reused *inside* the
  Proposed-lane cards, with the email-kind drawer for edit-in-place.
- **`/cx/approvals` (`app/(staff)/cx/approvals/page.tsx`)** is removed; its held-payout +
  approval rendering moves into the lane. `HeldPayoutCard` either joins the lane or becomes
  a `Release ▸` row in the exception table (open question — see below).

## Deferred / open questions (intentionally not decided here)

- **Confidence instrument + per-kind auto graduation** — the agree-rate is only a chip
  today. The full instrument (what to measure: approve/reject/edit rate per kind; how
  "ready for auto" is decided; a **per-kind** auto toggle rather than one global
  `workflow_mode` flip) is the piece that actually gets the team *to* auto. **Its own
  session.** It likely wants `order_approvals` to record the outcome (approved-as-is /
  edited / rejected) so the rate is derivable.
- **Per-row action model** — optimistic-fire + undo toast vs. a small confirm. Money
  actions (`Release`/`Settle`) probably want a confirm; `Mark delivered` maybe not.
- **Ownership / claiming** — the desk is stateless (recomputed from source each load), so
  two CX people could act on the same row. Fine at semi-mode volume; revisit if the team
  grows. Not building claim/snooze now (the user did not pick the "desk workflow" focus).
- **Where held payouts render** — as cards in the Proposed lane (uniform with approvals) or
  as `Release ▸` rows in the exception table (money category). Mockup currently shows the
  latter.

## Non-goals

- No new automation *model* beyond the existing `manual`/`semi`/`auto` `workflow_mode`
  (per-kind graduation is a *future* refinement, flagged above, not part of this).
- No real-time collaboration, no claim/snooze/assignee this round.
- Consistent with the POC constraints in `CLAUDE.md` (no new auth providers, no heavy test
  suites beyond the lightweight `node --test` convention).

## Relationship to other work

- **Backend machinery:** [`2026-07-26-semi-auto-approvals-design.md`](./2026-07-26-semi-auto-approvals-design.md)
  — the effect-gate, executor, generalized `order_approvals`, and `ApprovalPanel` this IA
  renders. **That doc should ship (or be shipping) before this UI is built.**
- **Performance:** the CX desk is a likely always-open, auto-refreshing page. The
  `gatherAttention` gather is ~11 queries; the recent perf pass made it request-cached
  (`lib/authCache.ts::getAttentionCached`) but flagged moving the distinct-order count /
  gather into a SQL RPC if it becomes the always-open surface. Fold that into the build.
- **Order lifecycle map:** any order-loop-affecting change updates `lib/lifecycle.ts` in
  the same PR (repo rule). Rendering-only IA changes don't, but the approvals generalization
  does.

## Next step

When the team wants to build: turn this note into an implementation plan (writing-plans),
sequenced *after* the semi-auto-approvals machinery lands. The most valuable follow-on
*exploration* is the **confidence instrument / per-kind auto graduation**, since that's the
mechanism that realizes the "semi is an on-ramp to auto" thesis.
