# Manager review: what are the managers missing?

The weekly review of the Garden 1.2 managers (Harvey, Donna, Louis) and Mike,
the engineer. It holds them to account the way you would review a real team:
not "how close are you to your number", but what they're missing, how they
work, where they get stuck, and whether their fixes are real.

Designed in conversation on 2026-10-26. Builds on `../garden-1.2/` (the cast,
cards and Rule pulse) and topic 5 (`../topics/5-a-judge-for-each-agents-targets.md`).

| File | What it is |
|---|---|
| `manager-review.html` | The page. Real numbers from `factory_tasks`, `factory_runs` and the agent-factory PRs, 13–26 Oct 2026, pulled by hand (test cards left out). Not refreshed automatically. |

## What the page shows

1. **One sentence** saying how the team did.
2. **One funnel:** alerts, then cards from opened to held. Each bar shows
   what carried on and what left at that step, and why.
3. **Five questions**, one line each. Click a line to open the table that
   proves it.

The Rule pulse in `../garden-1.2/` gives the numbers. This page explains them.

## The five questions

| Question | What it looks for |
|---|---|
| What isn't on anyone's desk? | Alerts that never became a card: no rule fits, the daily cap was spent, or a slow problem that never reaches x alerts in y days. Customer complaints, once they're connected. |
| How are they going about it? | Mike's approaches (fix the cause, work around it, change the alert, ask a person) and which ones hold. How each manager writes "fixed", and whether you can measure it. |
| Where did they get stuck or go quiet? | Silent stops (time cap, no report), cards blocked by missing access, and fixes sent back for the same reason twice or more. |
| Did the fixes actually fix it? | Alerts per 100 orders on the rule, before vs after. A rule only counts as fixed if it went quiet for a real reason: not because the PR changed the alert, orders fell, or the alerts moved to another rule. |
| Where's the time and money going? | Agent time vs your review time, cost per real fix, and spend on work that didn't land. |

## Rules for the reviewer

- It only reads: card states, `factory_runs` outcomes, sweep alerts, PRs. It
  writes only its own review. It never changes code, briefs or scores.
- Nobody grades themselves. A manager passing Mike's PR is not a score; only
  "held" and "came back" are.
- Each manager is compared with their own past, never with each other.
- Rates per manager start at 10 closed cards. Before that, counts only.
- Mike's waiting time and your review time are kept apart.

## Still open

- Wiring the page to live data.
- How often it runs, and its cost cap.
- What counts as "the same reason" when a fix is sent back.
- Whether run traces record each tool call, which is needed to spot Mike
  repeating the same instruction.
