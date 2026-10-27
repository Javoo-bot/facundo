# Topic 4: What an agent may do alone

**Goal:** let agents merge a fix on their own when it serves a rule that is
already set, and keep people for the real decisions plus a weekly review.

## Where we are (review of 2026-10-26)

- The executor only opens draft PRs and never merges (`agents/factory/README.md`).
- Protected files always need a person: payouts, Airwallex, login, staff
  roles, email/SMS senders, migrations, `.github/`, `.claude/`
  (`PROTECTED_PATHS` in `agents/factory/executor.mjs`).
- A "free lane" that merges after the dashboard checks pass already exists
  (commit e01f9cd2, PR #21). Check what it covers before designing anything
  new.
- The owner's standing rule since 2026-10-15: no per-case questions; decide,
  record, and he steers from ideas.

## The owner's direction

An agent may decide on its own when the change:
- improves one of the rules already set,
- fixes a problem the rule covers, or
- fixes a case the rule implies but doesn't spell out.

Rules should be written more broadly to give agents that room. Specific
decisions still come to him, and once a week he reviews what the agents
decided and adjusts.

## Evidence from the trouble paths (2026-10-26)

Garden 1.2 Part 2 (`../garden-1.2/part-2/`)
shows what agents already do alone and where that goes wrong:

- **At work, agents already act alone most of the time.** Garden data, 14 to
  23 October:
  - closed as handled: 1,226 cases,
  - apologised and moved the date: 527,
  - answered alone: 878.

  Money steps never run alone (382 held), as the rules require.
- **The cheapest first freedom is dropping a card that is working as
  designed.** 11 of the 17 runs that didn't end in a fix found nothing
  broken. Dropping such a card serves an existing rule, so it fits the test
  in item 1 below. It is logged as `dropped_as_designed` for the weekly
  review.
- **Freedom without checking repeats mistakes.** The planner keeps trying
  recovery steps that almost never work here (cold offer 0 of 391), and Mike
  retries a card with the same brief. Any merge rule needs a "this has
  failed before" check, not only "tests pass".

## To settle

1. A test a machine can run: "it serves an existing rule" means what, exactly?
   (Names the rule, the measure goes up, tests pass, stays off protected files?)
2. Which rules get broadened, and who writes the broader version.
3. Where agent decisions are logged for the weekly review
   (`docs/agent-factory/decisions.tsv` exists).
4. How to undo one: an auto-merge that makes a measure worse.
5. Depends on topic 3: the checking has to be solid before more freedom.

## Done when

The merge rule is written in the factory spec, the free lane follows it, and a
weekly decision list exists for the owner.
