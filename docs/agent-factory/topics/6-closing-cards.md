# Topic 6: Closing cards

**Goal:** the factory agent owns a card from start to finish, and closes it
when the problem has really stopped.

## Where we are (review of 2026-10-26)

- Nothing ever closes a card. The sweep refreshes cards but never sets `done`
  (`agents/factory/README.md`, step 6).
- A card with a PR stays `in-progress` for good. A card with no change goes
  back to `open`.
- The plan in `docs/agent-factory/human-loop.md`: check the count a week after
  the fix and report it.
- The tickets board (artifact "Agent tickets") was made by hand on 23 Oct.
  Nothing keeps it current.

## The owner's direction

The factory agent that handles the PRs should also close the cards: open,
follow, close.

His note stops mid-sentence ("With this review it…"). Get the rest from him
first.

## To settle

Proposed answer for 1, 2 and 4: topic 7 (the rulebook page). A card closes
when its rule line is quiet for y days, reopens if it comes back, and the page
is the board.

1. When a card closes: no new alert for y days after the merge? Uses topic 1's
   numbers.
2. What happens if the problem comes back after closing: reopen, or a new card?
3. What happens to a PR nobody merges: close it after some days?
4. Should the board be generated from the cards and tickets every day?

## Done when

Cards close on their own when their alert stops, a test proves it, and the
open card count falls without anyone tidying by hand.
