# Topic 5: A judge for each agent's targets

**Goal:** each agent's targets are measured by someone other than the agent,
so no agent can pass by changing how it is scored.

## Where we are (review of 2026-10-26)

- Targets live in each `agents/thinking/<id>.md` under "What good looks like".
  An agent may never edit the Minimum or Window lines (rule 13,
  `docs/agent-factory/agent-minimums.md`).
- But the scores come from code and SQL: `agents/monitoring/schema.sql`
  (`agent_measure_cases`, `agent_daily_metrics`) and
  `agents/factory/thresholds.mjs`. A factory run could change those.
- Only 2 of 11 agents were measured last week (ticket #36). Concierge scores 0%
  because nobody in the garden answers (ticket #34; idea: a cheap judge plays
  the person for 20 cases a day).

## The owner's direction

Reading the results from outside data is good. A different agent should check
each agent's targets, because otherwise the agent can overrule itself and
cheat.

**What the judge measures (2026-10-26):** not how close the agent is to its
number. "62% of the way to 100 PRs a day" is easy to compute and says nothing
about why. The judge reads each agent's runs and answers four questions:

1. **Strategies.** What is the agent doing to reach its goal? Name the
   approaches it actually uses, and which ones lead to a pass.
2. **Failure pattern.** When it misses, what do the misses have in common?
   (Same kind of input, same step, same missing tool or permission.)
3. **Silent stops.** How often does a run end without saying it failed? No
   outcome line, stopped at the time cap, or finished with no change and no
   reason.
4. **Retry loops.** How often does it hit something it can't do and repeat the
   same instruction (5 times or more) until the loop runs out, instead of
   stopping and saying so?

Questions 3 and 4 are counts, so they can be trended per agent per week.
Questions 1 and 2 are short written verdicts with links to example runs.

Where the judge reads from: run traces (`agent_trace_runs`: output and
metadata per run) and factory run outcomes (`agents/factory/executor.mjs`
already records `fixed`, `gave-up`, `needs-human` and `failed`, with "stopped
at the time cap" and "no report" as failure notes, both silent stops). Retry
loops need the tool-call sequence of a run; check whether traces carry it
before building anything.

## To settle

1. Who the judge is: one shared judge agent, or a pair per agent?
2. What the judge may read and write (read-only on the results, its own
   verdicts only).
3. Lock the scoring files: add them to the protected list, so a change needs a
   person?
4. How often it judges, and its cost cap.
5. What counts as "the same instruction" for a retry loop: identical tool call
   and arguments, or the same intent reworded?

## Done when

Every agent has at least one measure scored by someone else, no factory run
can change its own agent's scoring without a person, and every agent has a
weekly judge report answering the four questions above.
