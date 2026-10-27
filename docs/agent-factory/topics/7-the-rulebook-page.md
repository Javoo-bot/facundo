# Topic 7: The rulebook page

**Goal:** one page of rules, where every line shows the alerts and cards it
caused, so any card can be traced back to the sentence that opened it, followed
while it is fixed, and seen closing.

This page answers parts of topics 1, 2 and 6 in one design.

**Later decisions (same day) live in `../garden-1.2/README.md`:** 13 general
rules over the 113 situations, the chain of command (brief, code, check, last
word), the managers (Harvey, Donna, Louis, with Jessica as the human), and the
Rule pulse page. Where this file and that one disagree, that one wins.

## The idea (the owner, 2026-10-26)

Read the rules like a one-page document. Under each rule, a badge shows what it
is causing right now:

```
accept-then-bail  Florist accepts, then can't actually fulfil.        Owner: Scout
  ● 23 alerts (7 days) → 3 cards → PR #41 merged 20 Oct → quiet 6 of 7 days → closes 27 Oct
  ○ 2 near: accepted, gave it back, next florist refused in chat

(no line)  offer past deadline (12), late delivery (4)                ← today's silent drops
```

## One source of truth

The rule lines ARE the branches in `dashboard/lib/lifecycle.ts`. No new
rulebook file, no stored map next to it.

- Order-loop rules: the lifecycle branches, which already have ids, triggers
  and handling.
- Photo rules: already lifecycle branches (`deliver-bad-photo`, ...), and
  Hawkeye's alert keys already use those ids.
- Chat rules: the `x-*` cross-cutting entries (`x-ai-reply-wrong`, ...). New
  chat rules are added there too.
- Each line gains an owner (the agent). That replaces `STUCK_OWNER`,
  `LIFECYCLE_OWNER` and the photo map in `agents/factory/cards.mjs`.
- `/lifecycle` and the rulebook page are two views of the same file.

## How a card lives on a line

Every card carries the id of its line (`rule: "accept-then-bail"`).

- **Open:** x alerts in y days on the line (topic 1's numbers).
- **Close:** after the fix is merged, no alert on the line for y days
  (topic 6). Same rule, run backwards.
- **Comes back:** a new alert on a closed line reopens the same card, shown
  as "came back".
- **No line:** an alert whose key matches no line is listed at the bottom of
  the page, never dropped (topic 2).
- The page is rebuilt on every sweep and replaces the hand-made "Agent
  tickets" board.

## Borderline cases: rules have neighbours

Example: an order that CAN be placed. Florist A accepts, then gives it back.
Florist B accepts, then refuses after a chat. This is not "can't be placed",
and it is more than one `accept-then-bail`. The agent should still assign it
to the nearest rule instead of dropping it.

How, without a second source:

1. **Exact first.** An alert whose key equals a line id goes to that line.
2. **Nearest second.** An alert with no exact line is sent, with the order's
   short story (the events, in order), to Haiku together with the list of
   lines (id, trigger, handling). It answers: the nearest line, how close
   (`near` or `far`), and one sentence on why. `far` counts as no line.
3. **Shown, not stored.** The card is stamped `rule: <id>, match: near` and
   the page shows it under that line as a hollow dot. The "map of
   neighbours" is this picture, worked out again on every sweep from
   `lifecycle.ts`. Nothing is saved that could drift.
4. **Neighbours grow into rules.** When near cases on one line repeat (x in
   y days), the card's job is a PR that adds a new branch to `lifecycle.ts`
   for them. The borderline becomes a rule of its own, so the source grows
   and the guessing shrinks.

Why not a vector database: there are about 150 lines, which fit in one
prompt. A vector store would hold a copy of the rule text, and that copy
would drift. That would be a third source of truth. If the list outgrows a
prompt, embeddings can be rebuilt from `lifecycle.ts` on every sweep, as a
cache and never as a source.

## Settled (the owner, 2026-10-26)

1. **Near matches count toward their line's card.** They never open a card of
   their own.
2. **The owning agent decides on a new rule.** It reads the near matches on
   its line and, when they repeat, adds the new branch itself. Before adding
   it, the agent replays the last 30 days of alerts against the new branch
   and writes in the PR what it would have caught. The owner watches this on a
   "new rules" view (below) and does not approve each one.
3. **Cost cap: 0.50 dollars a day for the near step.** The sweep runs every
   30 minutes. One Haiku call per sweep, with all unmatched alerts in one
   batch, and only for alert keys not already stamped on a card. At about 2
   cents a call, that is under 1 dollar on a busy day, and the cap stops it
   there. Past the cap, alerts go to the "no line" list until the next day.
   Nothing is lost.
4. **PRs that need a person:** The owner handles them. The page shows them as
   "waiting on review" and does nothing else.

## The "new rules" view

Each branch in `lifecycle.ts` gains three fields when an agent adds it:
`addedBy` (the agent), `addedOn` (the date) and `fromNear` (how many near
matches it grew from). The view is the same rulebook page, filtered to
branches with `addedBy`, newest first. Each row shows the agent's reason, the
30-day replay and its PR. It needs no new store, because the fields live on
the branch.

## How others do this

- **Sentry** groups errors the same way: exact fingerprint first, then an AI
  fallback that compares a new error with existing issues using embeddings
  and merges it when close enough. It is tuned to keep cases apart when
  unsure, applies only to new issues, and every merge can be undone from a
  "merged issues" list. Our "near/far" step and the hollow dots copy this.
  The "undo" here is the owning agent moving a near match to another line.
- **AlertGuardian** (alert research, 2026): a rule agent proposes rule
  changes with a written reason, and a review agent checks each one against
  past alerts before it is accepted. That is the 30-day replay in point 2.
- **AURA** (2026): the list of categories is frozen after discovery so it
  does not drift, and new ones are added only through review. That is why
  only the owning agent can add a branch, through a PR.

## Where it runs: not Cloudflare

- The sweep already runs on GitHub Actions every 30 minutes and writes to the
  garden database. The near step is one more call in that sweep.
- Cloudflare Vectorize would keep a stored copy of the rule text, which is
  the third source of truth this design avoids. About 150 lines fit in one
  prompt and can be compared in memory.
- Cloudflare's own embedding model (Workers AI) is almost free, but it gives
  only a distance with no reason. The owning agent needs the one-sentence
  "why" to decide on a new rule.
- Revisit this if the rule list outgrows one prompt. Embeddings would then be
  rebuilt from `lifecycle.ts` on every sweep, as a cache.

## Still open

- The rest of the owner's note in topic 6 ("With this review it...").

## Done when

Every card names its line, the page draws lines with their alerts, cards,
PRs and closing countdown from `lifecycle.ts` alone, the example above lands
under `accept-then-bail` as a near match in a test, and the "no line" list is
what topic 2's sweep log used to hide.
