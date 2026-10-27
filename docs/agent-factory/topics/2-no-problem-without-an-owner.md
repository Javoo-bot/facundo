# Topic 2: No problem without an owner

**Goal:** every alert ends up with someone, and nothing is silently dropped
because no agent owns it.

## Where we are (review of 2026-10-26)

- `agents/factory/cards.mjs`: an alert with no agent owner gets no card. It is
  only printed in the sweep log ("Signals no agent owns").
- Stuck orders: only `escalated:pool_exhausted` has an owner (Scout). Still
  dropped: awaiting reach-out, offer past its deadline, needs next florist,
  late delivery, and every other escalation reason.
- Garden tests on lifecycle branches missing from `LIFECYCLE_OWNER` are
  dropped the same way.
- Chats of a kind other than support or recruiting are dropped too.

## The owner's direction

He does not want to miss a card because there is no agent behind it.

## To settle

Proposed answer for 2 and 3: topic 7 (the rulebook page). Each rule line
names its owner, alerts with no line are listed on the page, and near cases
go to the nearest line.

1. Who owns the order loop's problems: the Planner, the factory agent itself,
   or a new "order loop" owner?
2. Should a dropped alert at least open an "unowned" card, so it is visible?
3. Should the rule be that `cards.mjs` throws on a signal with no owner, the
   way it already throws on an unknown agent?

## Done when

The "Signals no agent owns" list in the sweep is empty by design, a test proves
each stuck-order reason reaches a card, and the last sweep's dropped alerts are
accounted for.
