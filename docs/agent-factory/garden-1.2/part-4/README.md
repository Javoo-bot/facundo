# Garden 1.2, Part 4: Manager Control Room

The first three screens of the agent control app. Designed in conversation on
2026-10-26, after the research in `research.md`. Builds on Part 1 (`../`), the
manager review (`../../manager-review/`) and Part 2 (`../part-2/`).

| File | What it is |
|---|---|
| `control-app.html` | The page, built. Open it in a browser. |
| `control-app.template.html` | The page source, with a placeholder for the data. |
| `control-app.mjs` | The pure half: garden rows in, each manager's facts, signals and flows out. Every fact is a rule over counts. |
| `control-app.test.mjs` | Its tests. |
| `build-control-app.mjs` | Rebuilds `control-app.html` from the garden database and the `garden` branch's merge commits (read-only). Needs that database, so it does not run on a fresh clone. |
| `test-audit.json` | The latest test audit (26 Oct): which fixes pass their tests with the main fix removed. Updated by hand after each audit. |
| `REFRESH.md` | What the morning cloud routine does. |
| `research.md` | What others do (Meta ACH, Warp, Hamel Husain, Raindrop, Devin, Langfuse, ZenML) and which source inspired each screen. 56 of 66 sources confirmed. |

```bash
node --test docs/agent-factory/garden-1.2/part-4/control-app.test.mjs
```

In the original setup a cloud routine rebuilt and republished it every
morning, following `REFRESH.md`. The build reads the garden's own database,
which is not part of this repo, so the committed `control-app.html` is a
snapshot from 27 October 2026 with identifiers replaced by placeholders.

Counting rules worth knowing:

- Factory fixes merge into `garden`, not `main`. Only merges of a
  `factory/card-*` branch count, because older history carries PR numbers
  from another repo.
- Git writes merge times with a local offset and the database writes UTC, so
  times are compared as dates, never as text.
- Test cards (titles starting `TEST`) are left out of every count.

## Decided (the owner, 2026-10-26)

1. **Three screens.**
   - Which manager today.
   - Where it struggles and what it isn't saying, side by side, because a
     manager hides things inside specific flows.
   - Fix it and watch.
2. **Verification tests:** to be discussed after seeing the pieces together.
   Screen 3 shows today's pieces as they are.
3. **Proving a manager fix:** replay its past cards with the old brief, the
   new brief, and an unchanged copy as a control, then watch live.

## The screens

| Screen | Question | Data it uses |
|---|---|---|
| 1 | Which manager needs me today? | Manager review (cards, merged, came back), trouble-paths roots, test audit |
| 2 | Where does it struggle, and what isn't it saying? | Trouble-paths desk graph and roots, four yes/no signals, the test audit per fix |
| 3 | Did the fix to its instructions work? | Proposed brief change, replay (not built), verification pieces from today |

Screen 1 orders managers by how many red facts each has today, never by
comparing their scores (Part 1's rule: each manager against its own past).

The four signals on Screen 2:

1. Saw it, didn't act.
2. Said "fixed" without proof.
3. Keeps trying what fails.
4. Held or gave up without a reason. This one isn't recorded yet; it needs
   the manager log from Part 2.

## Missing before it can run on live data

- Saved versions of each manager's brief.
- A replay tool that answers tool calls from the recording.
- The "main fix removed" run recorded on every card.
- Mike's runs sending their `tests.json` test cards.
- 30 or more cards labelled by a person, to check the automatic grouping.
