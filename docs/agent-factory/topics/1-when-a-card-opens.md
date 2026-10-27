# Topic 1: When a card opens

**Goal:** write down what a card is in a place the agents read, and open a card
only when a problem repeats, not on the first alert.

## Where we are (review of 2026-10-26)

- The rule lives only in code: `agents/factory/cards.mjs` (`buildCards`) and
  `agents/factory/thresholds.mjs`. No spec or README says what a card is.
- One alert is enough to open a card. There is no minimum count. Result: 131
  open cards, one problem split into 85 (ticket #31).
- Alerts are grouped by agent + source + reason, keeping the 5 newest examples.
- The "below a minimum" rule (two days running) is the only one with a time
  rule. It is written down in `docs/agent-factory/agent-minimums.md`.
- `docs/agent-factory/human-loop.md` plans "3 times in a week", but it was
  never built.

## The owner's direction

- The definition must live in the agents' knowledge (factory README, spec, or
  `agents/knowledge`), not only in code that can change or get lost.
- Use a small statistical rule: a problem becomes a card if it shows up x
  times in y days.

## To settle

Proposed answer for 1, 3 and 5: topic 7 (the rulebook page).

1. Where the definition lives, and which file is the source the code follows.
2. The numbers x and y. Should they differ per source (chats, photos, stuck
   orders, garden tests)?
3. Count separate orders or chats, not raw rows, so that retries don't inflate
   the count.
4. A bypass: which single cases are serious enough to skip the wait (money, a
   customer harmed)?
5. Is "a fixed problem came back" an automatic card?

## Done when

The rule is written in one place the agents read, `cards.mjs` follows it, a
test proves one alert does not open a card and x alerts in y days do, and the
open card count drops.
