# Factory cards (Layer 6)

Garden only. `schema.sql` holds the queue: `factory_tasks` (one card, one
agent from `agents/thinking/`, one problem) and `factory_runs` (attempts at a
card). `sweep-signals.mjs` fills it every 30 minutes from
`.github/workflows/factory-sweep.yml`; `cards.mjs` is its pure half, tested by
`cards.test.mjs`.

Signals with no agent owner (most stuck orders: the order loop is code, not an
agent) are listed in the sweep's output and get no card.

## The executor: one card in, one draft PR out

`execute-card.mjs` runs on GitHub Actions
(`.github/workflows/factory-execute.yml`, dispatched by Trigger.dev at 07:00
and 13:00 UTC, the same times as its cron fallback). It can still run on the
laptop in the Docker box. `executor.mjs` is its pure half, tested by
`executor.test.mjs`. One run:

1. Closes runs left unfinished for over 3 hours (the laptop slept mid-run).
2. Picks the oldest `open` card with no run in progress, fewer than 5 tries
   and no try in the last 24 hours, and claims it: `open` to `in-progress`
   only if it is still `open`, so two executors never take the same card.
   Inserts the `factory_runs` row.
3. Writes the brief (the card, its one agent's file from `agents/thinking/`,
   the rules from `garden.md` and `verification-principles.md`) and a git
   bundle of the base branch (`garden` by default) into a fresh folder under
   `%LOCALAPPDATA%\Facundo\factory-runs\<run id>\`.
4. Runs the agent in the Docker box (`box/`): a clone made from that bundle,
   pstack mounted read-only, poteto-mode in the system prompt, Claude Code
   with a budget cap (`FACTORY_BUDGET_USD`, 5) and a wall-clock cap
   (`FACTORY_MINUTES`, 60). The only host folder it can write is `out/`.
   No home folder, no `.ssh`, no other project, no `.env`, no GitHub token.
5. Takes the agent's commits out of `out/result.bundle`, pushes
   `factory/card-<id8>` from the host and opens a **draft** PR with `gh`,
   body starting with the agent's plain summary. Never merges. A change to a
   protected path (payouts, Airwallex, login, senders, migrations, `.github/`,
   `.claude/`) still opens the draft but leads with "Needs a person" and
   records `needs-human`.
6. Records `outcome`, `branch`, `pr_url` and `notes` on the run. A card with a
   PR, or one the agent says needs a person, stays `in-progress`; a card with
   no change goes back to `open` and the notes say why. A card goes `done`
   only when the sweep stops seeing its signal (not built yet: the sweep
   refreshes cards but never closes them).

On GitHub the run is split into three jobs, each on its own fresh VM, so the
agent never holds what it does not need:

| Job | Holds | Does |
|---|---|---|
| `claim` | garden key, read-only repo token | steps 1 to 3 (`--phase claim`) |
| `agent` | `CLAUDE_CODE_OAUTH_TOKEN` only; no repo token on disk, sudo removed | step 4 on the runner itself (`--phase agent --runner local`) |
| `publish` | garden key, `contents` + `pull-requests` write | steps 5 and 6 (`--phase publish`) |

The throwaway runner is the sandbox (task 010's rule for unfamiliar
programs). The agent gets the same `box/run.sh`, the same caps (5 dollars, 200
turns, 55 minutes via `timeout`), pstack v0.9.57 cloned from
`michael-denyer/pstack-claude`, Claude Code at the box's pinned version, and
the deny rules in `box/agent-settings.json` (no `git push`, no `gh`, no
`sudo`, no `.claude/` or `.github/` edits). The cost and turns of each run are
in the publish log and in the `factory-out` artifact (`agent.jsonl`).

```bash
gh workflow run factory-execute.yml                          # oldest eligible card
gh workflow run factory-execute.yml -f card=<uuid>           # a chosen open card
gh workflow run factory-execute.yml -f executor_ref=<branch> # try executor changes
```

Secrets: `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`, long-lived),
`GARDEN_SUPABASE_SERVICE_ROLE_KEY`. The schedule fires only from `main`, so the
workflow file lives there too; the code it runs is checked out from `garden`.

Outcome table: `decide()` in `executor.mjs`. Fence evidence:
`docs/agent-factory/tasks/layer6-executor/probes.txt`
(`node agents/factory/execute-card.mjs --probe` reruns it).

### Running it

```powershell
node agents/factory/execute-card.mjs --dry-run      # which card, and its brief
node agents/factory/execute-card.mjs                # work it
node agents/factory/execute-card.mjs --card <uuid>  # a chosen open card
```

It reads `SUPABASE_API_KEY` (the garden secret key) from `FACTORY_ENV_FILE`,
default the main checkout's `.env`, and nothing else from that file. Docker
Desktop must be installed; the script starts it if it is down.

**Claude login in the box.** If `%LOCALAPPDATA%\Facundo\claude-oauth-token`
exists, its token is used. Otherwise the script borrows the host's own Claude
Code login (`~/.claude/.credentials.json`), which lasts hours and is
refreshed by one tiny host call when expired. To stop borrowing it, run
`claude setup-token` once and paste the printed token into that file.

### Laptop schedule (being retired)

Windows task `Facundo-Factory-Executor`, 09:00 and 15:00, one card per run,
no window (`run-hidden.vbs`), log `%LOCALAPPDATA%\Facundo\factory-executor.log`.
It runs from its own clone, `%LOCALAPPDATA%\Facundo\factory-executor`, so
nothing in a working checkout changes under it. Update it with
`git -C "$env:LOCALAPPDATA\Facundo\factory-executor" pull`.

```powershell
$vbs = "$env:LOCALAPPDATA\Facundo\factory-executor\agents\factory\run-hidden.vbs"
Register-ScheduledTask -TaskName Facundo-Factory-Executor -Force `
  -Action (New-ScheduledTaskAction -Execute wscript.exe -Argument "//B `"$vbs`"") `
  -Trigger (New-ScheduledTaskTrigger -Daily -At 09:00), (New-ScheduledTaskTrigger -Daily -At 15:00) `
  -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew)
```

Pause: `schtasks /Change /TN Facundo-Factory-Executor /DISABLE`
(`/ENABLE` to resume).
