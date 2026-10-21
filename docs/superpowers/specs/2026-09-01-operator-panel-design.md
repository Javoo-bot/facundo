# Operator panel — design

**Date:** 2026-09-01
**Route:** `/operator` (staff sidebar → OPERATIONS → **Operator**)
**System:** Production / Order Operations

## The problem

`/orders` answers *"what exists"*. Nobody's job is to know what exists.

Counted from the live screen, it carried **25 controls** above the work: a Shopify
id lookup, Pull from Shopify, a florist picker, a delivery-window picker, Generate
mock order, Clear mocks, Reconcile now, Reconcile all, Reconcile all (dry run),
Add orders by number, four stat tiles, the working-set banner, nine filter chips,
a search box, a sort select and a direction toggle. Below them, five rows that all
read `ESCALATED` in the status column and all read `Overdue` in the deadline
column.

A status every row shares ranks nothing. A deadline every row shares ranks
nothing. So the screen had 25 controls and no answer to the only question an
operator arrives with: **which one do I handle first?**

The page was built for an engineer inspecting a table. It was then handed to CX.

## The test this page has to pass

> Someone who has never seen the system opens the tab on Monday morning and
> knows, without being told, which order to handle first.

Everything below follows from that one sentence. Where a decision was arguable,
the tie went to whichever option a new hire could verify with their own eyes.

## Shape

One list. No toolbar, no filters, no sort control, no stat tiles, no tag banner.
Each row is exactly four things:

| | |
|---|---|
| **Countdown** | `30 min left` — live, ticks every 30s, the largest thing on the row |
| **What is wrong** | `No florist has answered yet` — a sentence, never a status code |
| **Which order** | `#MOCK-9204 · York, GB · 4 shops asked, none replied` |
| **One button** | `Contact a florist` — says what happens when you click it |

Then one line at the foot: *"167 other orders are running on their own — nothing
to do there."* That sentence is load-bearing. Without it a five-row page looks
broken; with it, the short list is the point.

## What it is built on

`lib/cxAttention.ts::gatherAttention` **stays the single source of truth** for
which orders need a human. It already gathers unplaceable orders, stalled offers,
pending approvals, florist issues, late deliveries, held/failed payouts, disputes
and Shopify conflicts, working-set gated, and it already feeds the sidebar badge
and the Control panel. This page adds no new notion of "needs attention" — three
surfaces reading one function is what stops them disagreeing.

Two things sit on top of it:

1. **`lib/operator.ts`** — the language layer. One `CxReason` in, one headline
   and one button label out. Pure and import-light (types only), so
   `lib/operator.test.mjs` covers every branch with plain `node --test`.
2. **The page's own two queries** — destination, and how the reach-out has gone
   (`4 shops asked, none replied` / `6 shops said no`). Indexed reads over only
   the orders on screen.

## Three decisions worth recording

### 1. The list is sorted by deadline, not by `urgency`

The brief said "sorted by urgency", and `gatherAttention` already ranks by an
urgency score — which is the right ranking for the Control panel, because it
weighs the *kind* of problem first (a breached offer SLA scores 100, an
unplaceable order 90) and the clock second.

Against the real staging queue, that order rendered as:

```
27 min left · 9 days overdue · 9 days overdue · 1 hour left · 25 hours left
```

Every position there is defensible and the list still looks unsorted — because
the operator can see the countdown and cannot see the score. A ranking nobody can
verify by eye is not a ranking to a new hire.

So the page sorts by the number it shows (`lib/operator.ts::byDeadline`): most
overdue first, then soonest due, then anything with no date. `urgency` is kept as
the tie-breaker, so between two orders due at 18:00 `gatherAttention` still
decides. Nothing about `cxAttention` changes — this is a view-level sort over its
output, and it copies the array rather than reordering the request-cached one the
sidebar badge shares.

### 2. Status codes are rewritten, not hidden

`ESCALATED` means nothing on day one, and some of our internal labels are worse
than meaningless — `Offer stalling — SLA breached`, `70% held — tier-hold`. Every
reason `gatherAttention` can emit has an explicit sentence in `lib/operator.ts`,
and the test walks the real source files to fail when a label is added upstream
without one. The `order_issues` types are spelled out individually too:
`issueLabel()`'s copy is a noun-phrase chip ("Missing ingredient"), which reads
fine beside a badge and badly as the one sentence on a row.

### 3. `Overdue` stops being the deadline column

Five rows reading `Overdue` rank nothing. A live countdown does, and it is the
same fact stated usefully. `countdown()` is coarse on purpose — minutes under an
hour, whole hours to two days, then days. Nobody triaging a queue needs
`26 h 14 m`.

## Two bugs this surfaced

Both were found by running the real modules against the real staging database
(`dashboard/scripts/verify-operator.mjs`), not by reading code.

- **`candidates_exhausted` had no case in `cxAttentionRules.ts`.** It is what
  semi and manual mode *always* write when a candidate list runs out, and what
  every pre-refill row carries — so it is one of the commonest reasons in the
  table. It fell through to the escalated default, whose sentence is
  "No florist found", a claim this reason explicitly does not make: nobody looked
  past the first list, so untried shops may well remain. Now has its own label at
  the same urgency as `wave_ceiling`, which is the situation it matches.
- **Held payouts had no release surface.** `HeldPayoutCard.tsx` and the
  finance-gated `/api/orders/payout/approve|reject` routes both survived the
  removal of `/cx` on 2026-08-10, but nothing mounted the card, so a `tier-hold`
  leg could only be released by calling the API by hand. The panel's "Approve the
  payment" button needed somewhere to land, so the card is mounted on the order
  page at `#payout`, gated on `canManagePayouts`. This closes
  `pay-accept-no-release-surface` and `pay-deliver-no-release-surface` on
  `/lifecycle`, both open since 2026-08-10.

## What did NOT move

`/orders` is untouched and keeps every tool it had. It is now the reference list
you go to when you need to look something up, linked from the foot of the panel
as "See all orders". The sidebar badge moved to Operator: an escalated order is
counted there already, and two red pills for the same order read as two problems.

## Files

- `dashboard/app/(staff)/operator/page.tsx` — the server page
- `dashboard/components/operator/OperatorClient.tsx` — the list + the ticking clock
- `dashboard/lib/operator.ts` — reason → sentence + button, countdown, sort
- `dashboard/lib/operator.test.mjs` — 18 cases, including the "every reason is
  translated" guard that reads the upstream sources
- `dashboard/app/design-system.css` — the `.op-*` block
- `dashboard/scripts/seed-operator-demo.mjs` — staging fixtures, one order stuck
  in each way the panel knows how to describe (`--clean` removes them)
- `dashboard/scripts/verify-operator.mjs` — prints what the page will render,
  using the real modules against the real database

## Known gaps

- **The button lands on the order page, not on the control itself**, except for
  florist questions (`#issues`) and held payouts (`#payout`). "Contact a florist"
  opens the order rather than opening the Find-florists panel. Worth doing when
  the panels take a deep-link param.
- **No empty-state celebration beyond a line of text.** Deliberate for now.
- **The resting count is a whole-table count**, not working-set gated, so it can
  overstate how much is quietly succeeding. `Math.max(0, …)` keeps it honest at
  the boundary rather than showing a negative.
