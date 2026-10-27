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
   body starting with the agent's plain summary. Never merges, except the
   free lane below. A change to a
   protected path (payouts, Airwallex, login, senders, migrations, `.github/`,
   `.claude/`) still opens the draft but leads with "Needs a person" and
   records `needs-human`.
6. Records `outcome`, `branch`, `pr_url` and `notes` on the run. A card with a
   PR, or one the agent says needs a person, stays `in-progress`; a card with
   no change goes back to `open` and the notes say why. A card goes `done`
   only once its fix merged (`merged_at`, written by `after-merge.mjs` or the
   free lane) and its signal then stayed quiet 7 days (`quietCards()` in
   `general-rules.mjs`); never while a run is still going. See "General rules
   and a card's life" at the end.

**Managers brief before and check after (garden 1.2, chain of command).**
Every card except the doctor lane's has an owning manager (`managerFor()` in
`managers.mjs`): the owner of its general rule (`general_rule`), else
the manager that reads its agent's file. Harvey (supply: scout, bloom,
sherlock, cupid, quill, polyglot), Donna (order loop: concierge, babel,
planner, oracle, and error cards), Louis (proof: hawkeye). Their role files
are `managers/<id>.md`; they read `agents/thinking/` as knowledge and change
nothing. In the `agent` phase, before Mike (the coding agent) runs, the
manager writes a brief ("Fixed means", "Check", "Out of scope"), once per card
and again after a reopen, as a new version. Mike's prompt gets it. After Mike,
the manager reads his commits and report and gives a verdict; Mike's own
OUTCOME no longer decides:

| Verdict | PR | Card |
|---|---|---|
| `passed` | as before (free lane allowed) | as before |
| `sent-back` (reason) | none | open; the next try gets the reason |
| `sent-back`, already sent back `MAX_SEND_BACKS` (2) times | draft, needs a person | in-progress |
| `dropped-as-designed` (situation) | none | dropped |
| `to-jessica` (why), or no readable verdict | draft, needs a person | in-progress |

No brief means Mike does not run (a failed run). A card on `pay-exactly-owed`
goes to Jessica: parked at claim with a `to_jessica` event, never sent to Mike.
Each step is a row in `agent_events` with `case_id = card:<id>`:
`brief_written` (the brief and its version), `sent_to_mike`, `check_passed`,
`sent_back` (reason), `dropped_as_designed` (branch), `to_jessica` (why), so
garden 1.2's desk graph shows them. The question-and-answer flow behind
`to_jessica` is built separately. Each manager step runs Claude Code with
read-only tools (`box/run.sh manager`), capped at
`FACTORY_MANAGER_BUDGET_USD` (0.5) and 10 minutes. Rule ownership and the owner's
card numbers are not repeated here: `managers.mjs` imports the owners from
`general-rules.json` and `CARD_LIFE` from `general-rules.mjs`. Proof (2026-10-27): `managers.test.mjs`, each case failing on
a planted defect first, and an `--phase agent --runner local` run with a fake
`claude` (brief in Mike's prompt, his report in the check, sent back); not yet
a real run.

**When the agent is not sure, it asks the owner and waits.** If the fix depends
on a choice only the owner can make, the agent ends with `OUTCOME: question` and
a `## Question` section: one plain-language question and two to five lettered
choices (A, B, C...). `decide()` stores it on the card (`question` column) and
sets the card to `waiting_for_answer` (`WAITING` in `questions.mjs`); the
executor only picks `open` cards, so it skips it, and the quiet rule never
closes it. The question goes where the owner already looks: at the top of the
draft PR if the run committed anything, otherwise in a GitHub issue
"Question: ...". He replies there with one line, `answer: B` (a note after it is
passed on). Every sweep reads those comments (PR reviews too) and the first
answer from a person (owner, member or collaborator, never a bot) reopens the
card with the `answer` column set; it skips the 24-hour cool-off. The next
brief quotes the question and his pick, and works on `factory/card-<id8>-a<n>`
so the PR he answered on stays as it was. A question the factory cannot read
(no lettered choices, code words) is today's plain needs-human. Pure half:
`questions.mjs`, tested by `questions.test.mjs`. With a manager on the card,
a question skips the manager's check and goes straight to Jessica: a
`to_jessica` event carrying the question (`applyCheck()` in `managers.mjs`).
A rule card waiting for an answer still gets its evidence refreshed by the
sweep; a reopened card starts with no question or answer. Needs
`agents/supabase/migrations/20261027130000_factory_questions.sql` (status,
`question`/`answer`, run outcome `question`, live index) applied to the garden
after the rule-cards migration, and the workflow permissions in the same PR (sweep:
issues and pull-requests read; publish: issues write), which take effect once
on main. Without a GitHub token the sweep prints `answers off` and goes on.

**PRs are reviewed from a picture.** Every factory PR body leads with a
Mermaid graph of its changed files (`changeGraph()` in `executor.mjs`): one box
per file grouped by folder, with its +/- lines, red for protected paths, green
for wording/look, blue for other code; GitHub draws it with zoom and pan and
each box links to that file's diff. The agent's own notes fold away below it.
Over 1,000 changed lines (`PR_LINE_LIMIT`), publish splits the agent's commits
at a commit boundary into two stacked draft PRs (`splitPoint()`); the brief asks
the agent to commit big work in two parts so it can. The owner asked for both on
2026-10-22.

**Free lane (merges itself).** A run whose outcome is `fixed`, whose files are
all wording or look (`dashboard/lib/i18n/messages/`,
`dashboard/app/design-system.css`, `dashboard/components/BrandLogo.tsx`:
`FREE_PATHS` in `executor.mjs`, the same areas `.claude/rules/slack-roles.md`
gives marketing and the COO), that passes the gate and has at least one
screenshot or video, opens a **ready** PR and the publish job merges it into
the base once the dashboard's own typecheck and tests pass on its branch (a
PR opened with the workflow token starts no CI, so publish runs them
itself). The card goes `done` and publish dispatches `factory-after-merge.yml`
for the merge commit, since a token merge starts no push workflow. Failed
checks or a refused merge leave the PR open and the card in-progress. Everything else
(payouts, mixed files, no evidence, needs-human, doctor) stays a draft for a
person. Switch: `FACTORY_AUTOMERGE=1` turns it on; the workflow sets it from
the repo variable `FACTORY_AUTOMERGE`, default `1`, so
`gh variable set FACTORY_AUTOMERGE --body 0` turns it off. Off the workflow
(the laptop) it is off.

Proof so far (2026-10-22): tests only (`executor.test.mjs` free-lane cases,
`cards.test.mjs` quiet-card case, each failing on a planted defect first).
The garden database answered every REST call with 503 or a timeout all
afternoon, so neither a real free-lane run (its claim needs the database) nor
a real sweep could run. Next real check: plant a `TEST cloud-agents:` wording
card and run `factory-execute.yml` with `-f base=<a throwaway branch>`, so the
merge lands there and not in garden.

**Arena for risky cards.** The agent runs on Haiku 5.5 (`claude-haiku-5-5`,
`FACTORY_MODEL` overrides it). A card whose title, summary or agent is about a
risky area (payouts/Airwallex/refunds, login/auth/permissions, the senders,
migrations: the areas in `PROTECTED_PATHS`) runs on `claude-sonnet-5-5`
instead, and its brief gets a rule 9: plan with `pstack:arena` before changing
anything. Rule 4 (never change money, login or senders alone) still holds, so
those PRs stay drafts for a person. `riskyArea()` / `modelFor()` in
`executor.mjs`. The dry run prints the model: `--dry-run --card-file <json>`
previews a brief without the database. Proof (2026-10-22): `executor.test.mjs`
(fails when one area's words are removed) and a `--card-file` dry run of a
planted payouts card (`model claude-sonnet-5-5 (risky: payouts, plans with
pstack:arena)` and rule 9 in the brief); the garden database was down, so not
yet a dry run of a card read from it.

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

**Its own garden (GitHub only).** Before the agent starts, the `agent` job
boots `box/local-garden.sh` in the card's clone: a throwaway local Supabase
(db, auth, rest) with `supabase/schema.sql`, then the migrations in date order
(retried until nothing moves; three are skipped because `schema.sql` already
holds them, and anything that truly breaks is listed in
`$RUN_DIR/garden-notes.txt`), then `box/seed.sql` (four invented test shops,
four invented orders, nothing from staging), an admin staff user
`factory-staff@example.com` / `factory-local-garden`, and the clone's
dashboard on `http://localhost:3001` started through the verify skill. A
"Verify doctor" step checks it, then Docker and sudo are taken away. The brief
tells the agent the garden is there and to prove UI changes with
`.claude/skills/verify`. All keys are the local stack's own; nothing from the
real garden. The verify skill still talks to the side project's pooler, so
`box/verify-local.mjs` (a Node `--import` hook, set as the agent's
`NODE_OPTIONS`) points its `pg` at the local database without editing
`.claude/`. If the boot fails, the agent works with tests alone.
`-f base=<branch>` makes the agent work on (and PR into) another branch; for
test runs only.

Proof (2026-10-21, run 39617425004 on a TEST card): the boot took about 3
minutes, the dashboard answered HTTP 200 on 3001, the doctor passed all seven
checks, and the agent itself ran the doctor and `shot /orders` and reported
#F001 to #F003 ($0.22, 5 turns). Rerun with
`gh workflow run factory-execute.yml --ref <branch> -f executor_ref=<branch> -f base=<branch> -f card=<a TEST card>`.

**Evidence in every PR.** Each verify `drive` or `shot` the agent runs records
a video (`recording.webm`) and numbered screenshots. When the agent ends,
`box/run.sh` copies the verify evidence folder to `out/evidence/`, so it rides
in the `factory-out` artifact. The draft PR's first line links to the Actions
run, counts the videos and screenshots (or says "tests only"), and gives the
gate result (passed, or needs a person for protected paths) with the outcome
(`evidenceLine()` in `executor.mjs`). Videos never go into git: the evidence
folder is gitignored, and a run whose commits add a `.webm`, `.mp4` or `.mov`
is recorded as failed and opens no PR.

**The doctor lane (the factory fixes itself).** The sweep also reads the
last 24 hours of `factory_runs`. Two failed runs (time cap included) of the
same kind (`runFailureKind()` in `cards.mjs`: time cap, no report, box exit,
executor error, ...) make ONE card with source and agent `factory`. An outage
is not a code bug: an expired or invalid Claude login, a rate limit or an
Anthropic 5xx makes no card and is printed in the sweep output instead.
`.github/workflows/factory-doctor.yml` works only these cards (the normal
executor never picks them), with the same three jobs and
`agents/factory/doctor.md` as the brief. Its executor code comes from the git
tag `factory-good` (garden if the tag is missing), so a broken executor on
garden cannot stop its own doctor. `factory-good` moves only when the garden
executor (`factory-execute.yml`, executor ref `garden`) ends a run clean:
fixed, or no change and no failure. Doctor PRs are always needs-human. After
2 doctor tries without a PR a card is `parked` with a note on its last run;
a parked problem gets no new card until a person sets it done or dropped.
Schema: `factory` source and agent, `parked` status (rerun `schema.sql`;
applied to the garden 2026-10-22).

Proof (2026-10-22, run 39758993848 on the TEST card `d9bff976`): the doctor
claimed only the factory card, the agent made its one-line change ($0.38, 13
turns), and publish opened draft PR #17 with the gate "needs a person (doctor
PR)". GitHub dispatches only workflows that are on main, so that run came
from a temporary tag trigger, since removed. Once this file is on main:
`gh workflow run factory-doctor.yml --ref <branch> -f executor_ref=<branch> -f base=<branch>`.

**Errors become cards.** The worker sends `order_automation_failed`,
`order_match_failed` and `order_workflow_step_failed` to the garden's PostHog.
The sweep reads the last 24 hours of them, groups them by context (`webhook.*`,
`cron.*`, `workflow.<step>`, `match.<mode>`) and the first line of the error
(ids and numbers ignored), and makes a card (source `error`, agent `factory`)
for each group seen at least twice: `errorCards()` in `cards.mjs`, tested
against `fixtures/posthog-errors.json`. At most 3 new error cards in 24 hours;
a live one is only refreshed. The cluster rule does not fit (PostHog holds the
failures only, not the day's total cases). The normal executor works them with
`errors.md` as the brief. Schema: `error` source (applied to the garden
2026-10-22).
**Off until the owner adds a key**: the repo only has the write-only capture
token. Create a PostHog personal API key with read (query) scope on the
garden project and run `gh secret set GARDEN_POSTHOG_PERSONAL_API_KEY`
(optionally `gh variable set GARDEN_POSTHOG_PROJECT_ID`, default `@current`).
Until then the sweep prints `errors source off: no read key` and goes on.
A dispatch with `--ref <branch>` now runs that branch's sweep code (from
main it is still garden's).
Proof (2026-10-22, run 39761990041 from this branch): 76 tests green, then
`errors source off: no read key`; the sweep then timed out on the garden
REST read of `app_settings`, as every sweep from main did that morning.

**Slack intake: ops reports become alerts on a general rule.** The ops team
writes in `#cx-desk` fast: an order number and a few words.
`slack-intake-run.mjs` (a step of `factory-sweep.yml`, before the sweep) reads
the channel from its bookmark, finds the order, reads its live state (status,
last offer and florist, photo check, threads waiting on a person), and answers
in the message's thread in one plain line. The message ends as one of: an
alert on one of the 13 general rules (`factory_alerts`, source `slack`), the
team's own call ("it depends", no alert), ONE short question back (which
order, or which of up to 3 things), or, still unclear or unanswered after a
day, "I've passed this to the owner." `slack-intake.mjs` is the pure half (words in
Spanish and English, plus what the order's state says); `slack-intake.test.mjs`
drives both halves, the handler with a fake Slack and a fake garden.
A Slack alert is placed like every other (`slackAlert`): exact when the order's
state names a situation (`ruleIndex`), else on the rule the team's words or
answer picked (match `near`, no model call); its id is `alertId`'s, so the same
order reported again on the same thing is one alert seen again. From there the
sweep treats it like any alert: the rule's card opens, closes and reopens by
`CARD_LIFE` in `general-rules.mjs` (see "General rules" below); nothing in the
intake counts days.
**Off until the owner adds the Slack app** (no Slack token or bot code existed in
the repo): create an internal Slack app in the workspace (an internal app keeps
the normal `conversations.history` rate limits), bot scopes `channels:history`
(`groups:history` if `#cx-desk` is private) and `chat:write`, install it, invite
the bot to `#cx-desk`, then `gh secret set SLACK_BOT_TOKEN` (the `xoxb-` token)
and `gh variable set SLACK_CX_DESK_CHANNEL_ID --body C...`. Apply
`agents/supabase/migrations/20261027140000_factory_slack_intake.sql` to the
garden (after `20261027120000_factory_rule_cards.sql`). The `factory-sweep.yml`
step must reach main to run. Until then the step prints `slack intake off`.
Proof so far (2026-10-27): tests only; no real Slack or garden run.

**Customer complaints become alerts on a general rule (Jessica's desk, item 2
in the garden-1.2 README).** `complaint-intake.mjs` (a step of
`factory-sweep.yml`, after the Slack intake) reads complaints (order number,
text, date) from a CSV or JSON export of Octocom (`--file`), or from Octocom's
API (`--octocom`, the same `OCTOCOM_API` / `OCTOCOM_BASE_URL` the knowledge
base uses; only conversations that read as a complaint count). It links each
to its garden order, masks emails and phones, and writes it to
`factory_alerts` with source `complaint` (`complaintAlert` in
`complaints.mjs`), placed on a general rule by its words
(`classifyComplaint()`, en/es/de/fr/it). For "never arrived" and "late" the
order says which rule broke: nobody in range is `area-has-florists` (exact,
`match-none`), an offer nobody took is `offer-gets-answer`, an accepted order
is `accepted-gets-delivered` (exact `deliver-late` when late). A complaint's
alert is placed when the customer wrote, so an old export never counts as this
week's, and its id is the complaint's own ref (two customers on one order are
two alerts; a rerun adds nothing). From there the sweep treats it like any
alert: the rule's card opens, closes and reopens by `CARD_LIFE` in
`general-rules.mjs`; nothing in the intake counts days. Money complaints land
on Jessica's rule (`pay-exactly-owed`, a person's card). A complaint no rule
covers (price, website, range, anything else) is an alert on no rule (match
`none`), printed by the intake for the owner as a maybe-product-change, never a
card. No migration: `factory_alerts` comes from
`20261027120000_factory_rule_cards.sql`. Off until `gh secret set OCTOCOM_API`
and `gh secret set OCTOCOM_BASE_URL`; by hand:
`node agents/factory/complaint-intake.mjs --file export.csv --dry-run`.
Proof (2026-10-27): `complaints.test.mjs` (complaint alerts driven through the
base's `ruleCardPlan` and `quietCards`) and a dry run of
`fixtures/complaints.csv`; no live Octocom read and no real sweep yet.

**The verify map grows after each merge.** `.github/workflows/factory-after-merge.yml`
runs on every push to garden. If the pushed commit is the merge of a
`factory/card-*` PR (`mergedCardPr()` in `executor.mjs`: GitHub also lists open
PRs that merely contain the commit, so only the PR whose merge commit it is
counts), one job runs Claude Code (Haiku 5.5, `$2` cap, 20 minutes) with
`pstack:maintain-verification-skill` on the files that PR changed. Source pass
only: there is no dashboard running in that job. Any change under
`.claude/skills/verify/` (nothing else is kept) goes up as a draft PR
`factory/verify-map-<pr>` labelled `verify-map`; `.claude/` is protected, so it
always waits for the owner. Nothing to update means no PR. `after-merge.mjs` is the
I/O. Limits: a merge made by the workflow's own token (the free lane) starts no
workflow, so only merges a person makes trigger it; dispatch it by hand with
`gh workflow run factory-after-merge.yml -f sha=<garden commit>` once the file
is on main. The agent and the PR step share one job (asked for), so the agent
step gets only the Claude token, but could in principle tamper with the files
the PR step runs next; the PR step can only push a `factory/verify-map-*`
branch and open a draft.
Proof (2026-10-22, run 39762816435 in the private repo,
from a temporary tag trigger on a commit kept off this branch, since GitHub
dispatches only workflows on main): it found merged PR #7 from garden commit
`973000d3` (3 files), the agent ran ($0.44, success) and the result was
"nothing to update", so no PR.

**Owner memory.** The same job reads the card row (by its branch
`factory/card-<id8>`) for the card's agent, or takes it from a
`factory(<agent>):` title if garden cannot be read. Then it adds one line,
`- YYYY-MM-DD: <PR title> (PR #n)`, under `## Learned` in that agent's
`agents/thinking/<agent>.md`, and keeps the newest 20 (`appendLearned()` in
`executor.mjs`). The line goes in the same verify-map PR, so a PR now opens after
every card merge whose agent has a thinking file (agent `factory` has none). The
lines are facts only, never rules (the owner, 2026-10-16), and the parser ignores
the section, so the agent's rules hash does not change.
Proof (2026-10-22, run 39763453759 in the private repo,
dispatched from this branch with a throwaway base): for PR #7 it opened draft
PR #18 adding `- 2026-10-14: reply subjects come out as "Re: Re: …" (PR #7)`
under a new `## Learned` in `agents/thinking/cupid.md` (closed afterwards). The
card-row read timed out (garden overloaded), so the agent came from the title;
the card-row path has not run for real yet.

```bash
gh workflow run factory-doctor.yml                           # oldest factory card
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

## General rules and a card's life

Decided by the owner on 2026-10-27; the numbers are `CARD_LIFE` in
`general-rules.mjs`, the design is `docs/agent-factory/garden-1.2/README.md`
sections 1 to 5 (branch `docs/control-room`).

- **Alerts.** Every conversation escalation, stuck order, failed photo check
  and failed garden score is an alert, stored once in `factory_alerts`
  (`alertId()`: the same stuck order seen every 30 minutes is one alert).
- **Placing.** `general-rules.json` groups every situation in
  `dashboard/lib/lifecycle.ts` under one of 13 general rules, each owned by a
  manager (Harvey supply, Donna order loop, Louis proof, Jessica money) and
  briefed from one thinking file (`agent`). An alert whose key is a situation
  id lands on its rule for free. Otherwise Haiku 4.5 on OpenRouter
  (`OPENROUTER_API_KEY`) names the nearest rule, `near` or `far`, at most
  $0.50 a Madrid day (`NEAR_MATCH`); past the cap, or without the key, the
  alert waits for a later sweep. `far` is kept as "no rule" and printed.
  Every call, answered or failed, goes in `factory_near_calls`, which the cap
  sums; the reserve kept free before a call is the dearest call seen so far.
  A dry run never calls the model.
  `general-rules.test.mjs` fails if a situation sits under no rule or two, or
  if one an agent added lacks `addedBy`/`addedOn`/`fromNear`.
- **Opens** at 3 alerts on a rule in 7 days (near matches count): one card per
  rule, source `rule`, fingerprint `rule:<id>`.
- **Closes** once the rule has been quiet 7 days after the fix merged, counted
  from the later of `merged_at` and the newest sighting of any of its alerts
  (`factory_alerts.last_seen_at`: a problem still there is seen every sweep,
  so its rule is not quiet). The
  same rule applies to every other card kind, with its last refresh as the
  newest alert. A card with no merged fix stays open.
- **Comes back.** An alert seen on a closed rule reopens the same card
  (`reopened_at`, `reopened_count`); the executor counts only its runs since.
- Jessica's card (money) is never picked by the executor; a person briefs it.

Schema: `agents/supabase/migrations/20261027120000_factory_rule_cards.sql`
(apply on the garden after `schema.sql`, before this code runs).
