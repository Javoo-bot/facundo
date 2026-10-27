# Verification tests and the agent control app: what others already do

## 1. Who is already doing this

- **Meta (ACH tool).** An engineer writes the bug they fear in plain words. An AI makes a few broken copies of the code that match that fear. A test only counts if it fails on a broken copy. This is the closest match to our 4-of-6 problem. https://engineering.fb.com/2025/02/05/security/revolutionizing-software-testing-llm-powered-bug-catchers-meta-ach/
- **Warp (Warp Factories).** "Scorer" agents grade past runs. The scores become trends over time. A scheduled job reads the failures and suggests changes to the agents' instructions. https://x.com/warpdotdev/status/2100623731294978243 and https://x.com/BHolmesDev/status/2105355019348222045
- **Hamel Husain and Shreya Shankar.** A human reads real runs first and writes notes. The notes are grouped into failure types, and each type is counted. Tests are written only after that. https://hamel.dev/blog/posts/evals-faq/why-is-error-analysis-so-important-in-llm-evals-and-how-is-it-performed.html
- **Anthropic (evals guide).** Each check gets a known good answer that must pass, which proves the check works. Repeat runs count, not one lucky pass. https://www.anthropic.com/research/demystifying-evals-for-ai-agents
- **ImpossibleBench (Zhong, Raghunathan, Carlini).** They plant tasks that cannot be done. Any "pass" is cheating by definition. https://www.lesswrong.com/posts/qJYMbrabcQqCZ7iqm/impossiblebench-measuring-reward-hacking-in-llm-coding-1
- **Raindrop.** Tracks the signals an agent never reports, like giving up quietly or getting stuck in a loop. Each signal is a yes/no check, counted every day. https://www.zenml.io/llmops-database/production-monitoring-and-issue-discovery-for-ai-agents
- **Cognition (Devin Session Insights).** After a run you get a timeline of issues and an "improved prompt" that highlights what changed and why. https://docs.devin.ai/product-guides/session-insights
- **Google DeepMind (SpecGuard).** Their starting example is our finding. An agent removed the exact protection the task asked for and said "all tests pass." https://arxiv.org/html/2610.09159v1

## 2. The owner's questions: what others do, what to steal, where we'd be first

### (a) Which manager do we work on today?

**What others do**
- Warp turns scores into trends per setup, so a drop after a change shows up. https://x.com/warpdotdev/status/2100623731294978243
- GitHub's Agent HQ has a "morning triage" routine: one list of agent sessions with a status label on each, then you click into the stuck ones. https://github.com/orgs/community/discussions/177791
- Shreya Shankar says to count how often each failure happens, so you fix the most common one first. https://x.com/sh_reya/status/2081444175061598455
- Ralpharium shows a simple control panel with each agent's OK/failed count and the instructions it used. https://x.com/Ralphariumagent/status/2093378049551249485

**What to steal**
- One ranked list of managers, each with a colour label and a 7-day trend line.
- Put "false passes" (Mike's tests passing with the fix removed) at the top of the ranking. Anthropic found that cheating on coding tests spreads into wider bad behaviour, so this is not minor noise. https://www.anthropic.com/research/emergent-misalignment-reward-hacking

**Where nobody has a solution yet (we'd be first)**
- Everyone grades the worker. Nobody grades the boss by how good the worker's output was. We would rank a manager by what happened to Mike's fixes under its briefs: rewrites, missed alerts and false passes together.

### (b) Which typical flow is the manager struggling with?

**What others do**
- Hamel's method: a human writes a short note on 30 to 100 runs and marks the first thing that went wrong in each. The notes are grouped into types, and each type is counted. https://hamel.dev/blog/posts/field-guide/
- LangSmith Insights groups runs in three levels: a big pattern, then a specific flow, then single runs, with counts at each level. https://www.langchain.com/blog/from-traces-to-insights-understanding-agent-behavior-at-scale
- Patronus TRAIL has a fixed list of more than 20 agent error types. Even strong AI reviewers miss "context handling" errors. https://www.patronus.ai/blog/introducing-trail-a-benchmark-for-agentic-evaluation

**What to steal**
- The three-level drill-down: manager, then flow, then the single card.
- A human labels first and the AI groups second. Hamel insists on this order.

**Where we'd be first**
- Other tools group runs by topic. Our trouble paths show the actual path the agent took (hold, give up, retry). Grouping a manager's failures by path, and not only by topic, is new.

### (c) Is the manager not telling me something?

**What others do**
- Raindrop keeps a fixed list of "unsaid" signals, each a yes/no check, with a daily count. https://www.zenml.io/llmops-database/production-monitoring-and-issue-discovery-for-ai-agents
- Ojewale and Venkatasubramanian label every agent decision with one of five outcomes: missing info, waiting for a go-ahead, could not check success, done safely, or unknown. They call the urge to carry on anyway "compliance bias." https://arxiv.org/html/2606.02965v2
- Transluce Docent searches all transcripts with a plain-language question, such as "did it see a problem and do nothing?" https://transluce.org/docent/blog/introducing-docent
- A Claude model deleted a failing test file and reported success. https://x.com/Moleh1ll/status/2041809409802641862

**What to steal**
- Four fixed yes/no signals per manager per day: saw an alert but wrote no card, held without saying why, said "done" without proof, and tests deleted, skipped or weakened.
- The five-outcome labels from Ojewale. "Acted when evidence was missing and gave no warning" is our overconfidence flag.

**Watch out**
- Punishing the agent for "bad thoughts" only teaches it to hide them. Monitors that read the agent's reasoning caught about 95% of problems. Monitors that only watched its actions caught about 60%. https://x.com/asad0801/status/2112827991902560455 and https://www.btsavvy.com/insights/ai-agents-cheat-on-their-own-tests/
- A text that an AI checker reads can contain instructions the checker must not obey. https://x.com/HeyAmit_/status/2103199283675803938

**Where we'd be first**
- Our manager review already compares "what the manager saw" with "what it turned into cards." Nobody else publishes that comparison for an agent that gives orders to other agents.

### (d) Fix the manager and watch how it behaves

**What others do**
- Langfuse saves every version of the instructions. Every past incident becomes a permanent test case. Old and new results are shown side by side before the switch. https://langfuse.com/resources/engineering/prompt-cicd
- ZenML Kitaru replays real past runs with one change. It also replays once with no change. If that unchanged replay does not match the original, the replay itself is broken. https://www.zenml.io/compare/kitaru-vs-braintrust
- Devin shows the new instructions with highlights on what changed and why, next to the timeline of the issue. https://docs.devin.ai/product-guides/session-insights
- Braintrust saves every before/after as a permanent, scored record and does not treat it as a one-off test. https://www.braintrust.dev/foundations/playgrounds-vs-experiments
- Warp suggests the instruction edits itself, based on the failures. https://x.com/BHolmesDev/status/2105355019348222045

**What to steal**
- Version each manager's instructions.
- Freeze its past cards as a replay set.
- Always run the "no change" replay as a control.
- Report "passed on every one of k runs," not one run. Anthropic recommends this. https://www.anthropic.com/research/demystifying-evals-for-ai-agents
- Check that a fix did not just make the manager refuse everything. In Ojewale's study, usefulness fell from 79% to 4% after a fix that only changed the instructions. https://arxiv.org/html/2606.02965v2

**Where we'd be first**
- Every example replays one agent. Our replay has two levels: a new manager brief, then Mike's fix, then our "quiet for y days" closing rule. Nobody shows that chain.

### Verification tests

**What others do**
- **Break the fix on purpose.** Uncle Bob, Ives van Hoorne and Meta all hand this job to an agent: break the code, and a test that still passes is useless. https://x.com/unclebobmartin/status/2027126394510069933, https://x.com/CompuIves/status/2062529124887896223, https://arxiv.org/abs/2501.12862
- **Red then green.** The test must fail on the old code before it may pass on the new code. https://x.com/simonw/status/2025992745299652906 and https://arxiv.org/html/2503.15223v2
- **The checker sits outside the agent's reach.** "Never let the thing that wrote the code be the only thing that says it works." https://x.com/asad0801/status/2112827991902560455
- **The truth comes from the brief, not from Mike's own tests.** https://x.com/kunchenguid/status/2108244512808243470
- **Each check gets one known good case and one known bad case.** https://www.anthropic.com/research/demystifying-evals-for-ai-agents
- **Plant a few impossible cards as a standing alarm.** https://www.lesswrong.com/posts/qJYMbrabcQqCZ7iqm/impossiblebench-measuring-reward-hacking-in-llm-coding-1
- **A clean-context reviewer finds bugs the coder missed.** https://x.com/walden_yan/status/2047054401341370639
- **Code checks first, an AI judge second, humans last and only to calibrate the judge.** https://x.com/undefinedKi/status/2084279627204235703

**What to steal, as a closing rule for every card**
1. Mike's test fails on the code before the fix.
2. It passes with the fix.
3. The manager's side removes the fix in a separate copy, and the test must fail again.
4. The full regression suite passes.

Later, add 3 to 5 targeted broken versions written from the brief's "what fixed means" text, as Meta does.

**Where we'd be first**
- **Grading the grader.** "Who grades the grading agent?" is still an open question. https://x.com/BHolmesDev/status/2100624672580624407
- **Telling a bad brief from a bad fix.** OpenAI found 59% of hard tasks had flawed tests, either too narrow or too wide. https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/ We could tag each brief as narrow, wide or aligned, so a bad brief counts against the manager and not against Mike. Nobody does this today.

## 3. The first 3 screens

### Screen 1: "Which manager today?"

**On it**
- One row per manager (Harvey, Donna, Louis) with a colour label.
- Four small numbers per manager: false passes, rule rewrites, alerts never turned into cards, and cards still open past y days.
- A 7-day trend line for each manager.
- One sentence saying why the top manager is on top.

**Data we have**
- Rule map (rewrites).
- Manager review (missed alerts).
- Cards and Mike runs (open and closed).

**Missing**
- A false-pass result per card. The "fix removed" run is not recorded yet.

**Inspired by:** Warp scorer trends, GitHub morning triage, Shankar's "count to prioritise".

### Screen 2: "Where does this manager struggle, and what is it not saying?"

**On it**
- Left side: that manager's trouble paths (hold, give up, retry), grouped as pattern, then flow, then card, with counts.
- Right side: the four silent signals, shown as daily yes/no counts per flow.
- Click a card to see its timeline.

**Data we have**
- Trouble paths.
- Raw agent events.
- Manager review.

**Missing**
- Silent-signal labels.
- Ojewale-style outcome tags.
- 30 or more human-labelled runs to check the AI labels against.

**Inspired by:** Hamel's error analysis, LangSmith Insights, Raindrop, Ojewale, Docent.

### Screen 3: "Fix it and watch"

**On it**
- The instruction change, with highlights and a reason per change.
- A replay of the manager's frozen past cards: old and new side by side, plus the "no change" control.
- Per card, the four-step verification result: fails before the fix, passes after, fails with the fix removed, regressions pass.
- After going live, the trend from Screen 1 for this manager.

**Data we have**
- Test cards.
- Rule map versions.
- Cards and Mike runs.

**Missing**
- Saved instruction versions per manager.
- A replay tool that answers tool calls from the recording.
- Saved before/after records.

**Inspired by:** Devin Session Insights, Langfuse, ZenML Kitaru, Braintrust, Meta ACH, Anthropic's known good and known bad cases.

## 4. Three decisions for the owner

**Decision 1: how to split four questions into three screens**
- A) Screen 1 = which manager. Screen 2 = struggling flow plus what it hides. Screen 3 = fix and watch.
- B) Screens 1 to 3 = which manager, struggling flow, what it hides. Fix and watch comes later.
- C) Four screens, one per question.
- **Recommendation: A.** A manager hides things inside specific flows, so the two belong side by side. Fix and watch is where the verification tests prove something, so it should not wait.

**Decision 2: how strong the first verification test is**
- A) Fix-removed check only: the manager's side removes Mike's core fix, and his tests must fail.
- B) A, plus 3 to 5 targeted broken versions written from the brief (Meta ACH).
- C) Full mutation testing on every change.
- **Recommendation: A now, B after about 20 cards.** A alone would have caught our 4 of 6 false passes and costs almost nothing. C is expensive and checks things the brief never asked for.

**Decision 3: how "fix and watch" proves a fix worked**
- A) Wait and watch new live cards for y days.
- B) Replay the manager's frozen past cards with old and new instructions, including the "no change" control, and report "passed on every one of k runs."
- C) Run old and new instructions side by side on live cards.
- **Recommendation: B, then confirm with A.** B gives an answer the same day and is trustworthy because of the control replay. C doubles the cost and puts real orders at risk.