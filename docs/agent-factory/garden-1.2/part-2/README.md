# Garden 1.2, Part 2: Trouble paths

Part 1 (`../`) and the manager review count things. Part 2 draws them: the
steps a manager's agents usually take once a case goes wrong, where those
steps lead, and why. Designed in conversation on 2026-10-26.

| File | What it is |
|---|---|
| `trouble-paths.html` | The page. Open it in a browser. |
| `trouble-paths.template.html` | The page source, with a placeholder for the data. |
| `trouble-paths.mjs` | The pure half: events in, step graphs and causes out. |
| `trouble-paths.test.mjs` | Its tests. |
| `build-trouble-paths.mjs` | Rebuilds `trouble-paths.html` from the garden database (read-only). The database is not in this repo, so the committed page is a snapshot. |

```bash
node --test docs/agent-factory/garden-1.2/part-2/trouble-paths.test.mjs
```

## Two graphs

| Graph | Built from | One path is |
|---|---|---|
| **At work** | `agent_events` (garden): every turn, guard, plan, step, model error, rule gap and hold | one case (an order or a conversation) |
| **At the desk** | `factory_tasks` + `factory_runs` | one card: opened, each of Mike's runs, where it is now |

Both are directly-follows graphs: a line from A to B counts the cases where B
came right after A. Line width is the count. Red lines go into a failure,
amber into a hold or a give-up, and a loop marked ×n is the same step again.
The work graph shows its 24 busiest lines. The desk graph filters by manager.
Clicking a root-cause card under "Why it happens" lights up its lines on the
graph.

## Where to draw it (researched 2026-10-26)

- **Langfuse**: its agent graph shows one trace at a time. Keep it for
  opening a single run.
- **Arize AX**: has an "agent path" view, but we could not confirm that it
  covers more than one trace. Paid above 25k spans a month.
- **LangSmith Insights and Braintrust Topics**: group failing traces
  automatically, but draw no step graph. Using them would mean sending them
  our traces.
- **PostHog Paths**: shows at most 50 transitions and 5 steps, too short for
  a card.
- **Grafana node graph**: can draw the same edges live from a SQL view later.
- **pm4py and other process-mining tools**: this graph is what they do. We
  count the pairs in about 100 lines of JavaScript instead, so there is no
  Python and no licence question. When each manager has 10 or more closed
  cards, pm4py's decision tree can rank causes from card features.

## What the first build found (data up to 2026-10-23 18:50)

1. **The garden went silent.** It has logged no agent steps since
   2026-10-23 18:50. The page shows this in red at the top.
2. **One problem filed as 70 cards.** The planner puts the client's email
   subject into its reason (`dashboard/lib/conversations.ts:265` on
   `garden`), and `cards.mjs` makes a card per distinct reason.
3. **Working as designed is filed as a fault.**
   - At work, 425 of 1,554 rule gaps are holds the rules require.
   - At the desk, 11 of the 17 runs that didn't end in a fix found nothing
     broken.
4. **The no-florist ladder.** The recovery steps rarely work here:
   - reoffer wider worked 7 times in 429,
   - cold offer 0 in 391,
   - swap florist 6 in 125.

   The planner still tries them one after another: 367 cases failed two or
   more of them.
5. **Retrying a full model pool.** 286 of the 324 model errors are HTTP 429
   from the free pool. 30 cases retried 5 or more times in a row. The
   fallback model was used 0 times.
6. **Queue and no close step.**
   - 9.2 cards open a day, but only 2.3 runs a day work them.
   - 85 cards have never been worked.
   - Cards that gave up are retried with the same brief.

The numbers above are from the first build. The page recomputes them every
time it is rebuilt.

## What managers must log once they exist

The desk graph only sees Mike today, because the managers are still a design.
Each manager step becomes one row in the same event-log shape as
`agent_events`, with `case_id = card:<id>`. Then the desk graph shows the
managers' own steps with no change to the page:

| Event | When |
|---|---|
| `brief_written` | The manager says what "fixed" means. |
| `sent_to_mike` | The card goes to Mike. |
| `check_passed` / `sent_back` (`reason`) | The manager checks Mike's PR against its brief. |
| `dropped_as_designed` (`branch`) | Topic 4: a decision taken alone, which goes on the weekly list. |
| `to_jessica` (`why`) | It needs a person. |
| `quiet_day` / `closed` / `reopened` | The rule decides. |

## Still open

- A daily schedule for the build (a step in `factory-sweep.yml` needs a
  person, because `.github/` is protected).
- `runCause` reads Mike's notes with a word list. Once there are more runs,
  check it against a sample read by a person.
- The fixes for findings 2 to 6, as cards for their managers.
