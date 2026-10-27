// Pure half of the card executor (execute-card.mjs): which card to work, the
// brief the boxed agent gets, and what a finished run means. No I/O, so
// executor.test.mjs drives it with plain objects.

import { WAITING, answerBrief, parseQuestion, questionBlock } from "./questions.mjs";

export const MAX_TRIES = 5;
export const COOL_OFF_MS = 24 * 3600_000;
// A run with no finished_at older than this was killed with its host (laptop
// asleep, power cut). The next executor closes it so the card can be retried.
export const STALE_RUN_MS = 3 * 3600_000;
// The doctor lane (factory-doctor.yml) works only source 'factory' cards, at
// most this many times each; then the card is parked for a person.
export const DOCTOR_TRIES = 2;
export const GOOD_TAG = "factory-good";

// Paths a factory agent never changes alone (garden.md "never alone",
// verification-principles.md rule 14). A run that touches one still opens its
// draft PR, but the outcome is needs-human and the PR says so first.
export const PROTECTED_PATHS = [
  "dashboard/lib/airwallex/",
  "dashboard/lib/payout",
  "dashboard/app/api/payouts/",
  "supabase/migrations/",
  "supabase/schema.sql",
  "dashboard/lib/allowlist.ts",
  "dashboard/lib/staffRoles",
  "dashboard/app/auth/",
  "dashboard/app/api/auth/",
  "dashboard/lib/email.ts",
  "dashboard/lib/sms.ts",
  ".claude/",
  ".github/",
];

// The free lane: wording (email/SMS messages) and look (colours, logo). A
// fixed run that touches only these, passes the gate and has evidence opens a
// ready PR that the publish job merges itself (.claude/rules/slack-roles.md
// lists the same two areas as safe for non-technical people).
export const FREE_PATHS = [
  "dashboard/lib/i18n/messages/",
  "dashboard/app/design-system.css",
  "dashboard/components/BrandLogo.tsx",
];

// Arena: a card whose problem or agent is about a risky area gets a stronger
// model and plans with pstack:arena first. The words are PROTECTED_PATHS's
// areas (not .claude/ or .github/, which are about the factory itself) plus
// the plain words a card would use for them.
export const DEFAULT_MODEL = "claude-haiku-5-5";
export const ARENA_MODEL = "claude-sonnet-5-5";
const RISKY = [
  ["payouts", /payout|airwallex|refund/],
  ["login", /\blog ?in\b|\bsign ?in\b|\bauth(\b|entic|ori[sz])|oauth|password|allow ?list|allowed_emails|permission|staff ?roles?\b|staffroles/],
  ["senders", /\bsenders?\b|email\.ts|sms\.ts/],
  ["migrations", /migration|schema\.sql/],
];

export function riskyArea(card) {
  const text = [card.title, card.summary, card.agent].join(" ").toLowerCase();
  return RISKY.find(([, re]) => re.test(text))?.[0] ?? null;
}

export const modelFor = (card, fallback = DEFAULT_MODEL) => (riskyArea(card) ? ARENA_MODEL : fallback);

export const freeLane = (files) =>
  files.length > 0 && files.every((f) => FREE_PATHS.some((p) => f === p || f.startsWith(p)));

const OUTCOMES = ["fixed", "gave-up", "needs-human", "question"];

// A card resumed after the owner's answer works on its own branch, so the run
// that asked keeps its draft PR (where he answered) untouched.
export const branchFor = (card) => `factory/card-${card.id.slice(0, 8)}${card.answer ? `-a${card.answer.round ?? 1}` : ""}`;
const CARD_BRANCH = /^factory\/card-([0-9a-f]{8})(?:-a\d+)?$/;

// cards: open factory_tasks rows, each with runs: [{id, started_at, finished_at}].
export function staleRuns(cards, now) {
  return cards.flatMap((c) => c.runs)
    .filter((r) => !r.finished_at && now - Date.parse(r.started_at) > STALE_RUN_MS)
    .map((r) => r.id);
}

// Oldest open card that nobody is working, that has not used its tries, and
// that was not tried in the last day (a card that keeps failing must not eat
// every slot). Factory cards belong to the doctor lane alone. Jessica's cards
// (money) wait for a person. A reopened card counts only the runs since it
// reopened: the fix that held before is not a failed try. A card waiting for
// the owner's answer is not open, so it is never picked; once he answers, it
// skips the cool-off (he is the reason it stopped, not a failure).
export function pickCard(cards, now, { lane = "cards" } = {}) {
  const doctor = lane === "doctor";
  const eligible = cards.filter((c) => {
    if (c.status !== "open") return false;
    if ((c.source === "factory") !== doctor) return false;
    if (c.manager === "jessica") return false;
    if (c.runs.some((r) => !r.finished_at)) return false;
    const runs = c.reopened_at ? c.runs.filter((r) => r.started_at > c.reopened_at) : c.runs;
    if (runs.length >= (doctor ? DOCTOR_TRIES : MAX_TRIES)) return false;
    const last = Math.max(0, ...runs.map((r) => Date.parse(r.started_at)));
    if (c.answer?.at && Date.parse(c.answer.at) > last) return true;
    return now - last >= COOL_OFF_MS;
  });
  eligible.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id));
  return eligible[0] ?? null;
}

// The local garden agents/factory/box/local-garden.sh boots on a GitHub runner.
// Throwaway: a local Supabase that dies with the runner, so the login can sit in
// the brief.
export const LOCAL_GARDEN = { url: "http://localhost:3001", email: "factory-staff@example.com", password: "factory-local-garden" };

function whereYouAre(base, branch, localGarden) {
  const intro = `A fresh clone of the repo at \`${base}\`, on branch \`${branch}\`, inside a locked
sandbox.`;
  const alone = "Nobody is watching and nobody will answer.";
  if (!localGarden) {
    return `${intro} You have the code and npm. You have no database, no secrets, no
GitHub and no remote: you cannot query the rows above, only reason from the
evidence, the code and the docs (progress.md lists cracks the garden found,
some may match this card). ${alone}`;
  }
  const g = LOCAL_GARDEN;
  return `${intro} You have the code, npm and your own small garden: a local
Supabase seeded with a few invented florists and orders (not the rows above;
those live in the real garden, which you cannot reach), and this clone's
dashboard already running on it at ${g.url} with \`next dev\`, so your
edits show up live. Staff sign-in: ${g.email} / ${g.password} (throwaway,
local only). No secrets, no GitHub, no remote. ${alone}

To prove a change anyone sees in the dashboard, use the verify skill in
\`.claude/skills/verify\` (read its SKILL.md): it is already launched, so skip
\`launch\` and \`cleanup\`; run \`node .claude/skills/verify/control.mjs doctor\`,
then \`drive\` a recipe or \`shot <route> <name>\`, and name the screenshots in
your report. Its \`sql\` reads the local database. Every \`drive\` and \`shot\`
records a video and screenshots under \`.claude/skills/verify/evidence/\`; the
factory attaches that folder to the PR for you, so leave it there and never
commit a video. If ${g.url} does not answer, say so in the report and prove the
change with tests alone.`;
}

// The file the brief embeds: a factory card is about the executor (doctor.md),
// an error card about the order loop's code (errors.md), any other card about
// its agent's thinking file.
export function briefPath(card) {
  if (card.source === "factory") return "agents/factory/doctor.md";
  if (card.source === "error") return "agents/factory/errors.md";
  return `agents/thinking/${card.agent}.md`;
}

function arenaRule(card) {
  const area = riskyArea(card);
  if (!area) return "";
  return `9. This card is about a risky area (${area}). Before you change anything, plan
   with the pstack:arena skill (Skill tool) and follow the plan it settles on.
   Rule 4 still holds.
`;
}

export function buildPrompt({ card, agentFile, agentPath = `agents/thinking/${card.agent}.md`, base, branch, reportPath = "/out/report.md", localGarden = false }) {
  const age = card.latest_signal_at ? `newest signal ${card.latest_signal_at}` : "no signal date";
  return `You are the factory worker for ONE card. You work for exactly one agent: ${card.agent}.

## The card

- Title: ${card.title}
- What is wrong: ${card.summary}
- Source: ${card.source}; fingerprint \`${card.fingerprint}\`; ${age}.
- Evidence the sweep saw (garden database, a masked staging copy):

\`\`\`json
${JSON.stringify(card.evidence, null, 2)}
\`\`\`

## The agent you are improving: ${agentPath}

\`\`\`markdown
${agentFile.trim()}
\`\`\`

${answerBrief(card)}## Where you are

${whereYouAre(base, branch, localGarden)}

## Rules

1. pstack:poteto-mode is in your system prompt. Follow the playbook it picks and
   call the pstack skills it names through the Skill tool.
2. Read CLAUDE.md, docs/agent-factory/garden.md and
   docs/agent-factory/verification-principles.md before changing anything.
   They win over this brief.
3. One agent, one problem: change only what this card is about.
4. Never change alone: money (payouts, Airwallex, prices, refunds,
   substitutions), login and permissions, the email and SMS senders,
   supabase/migrations/. If the real fix is there, do not write it: put the
   proposal in the report and use OUTCOME needs-human.
5. Prove it with tests. Write or extend a test that fails on the current code
   (run it and keep the failing output), make the fix, run it green, then run
   the suite of the package you touched (dashboard: \`npx tsc --noEmit && npm test\`;
   ingest-worker: \`npm run typecheck && npm test\`; agents: \`node --test <dir>\`).
   Run \`npm ci\` in that package first. Never change a test or check that judges
   your fix (principle 13).
6. Commit your work on the current branch with clear messages. Do not push.
   Keep the change under ${PR_LINE_LIMIT} lines. If it must be bigger, commit it in
   two parts that each work alone, the first under ${PR_LINE_LIMIT} lines: the factory
   opens them as two PRs.
   Scratch notes go under docs/agent-factory/tasks/card-${card.id.slice(0, 8)}/, never .claude/.
7. Never use run_in_background and never end your turn to wait.
8. If the evidence is stale, already fixed in the code, or not a code problem,
   say so plainly and commit nothing. That is a valid result.
${arenaRule(card)}
## When you are not sure, ask

If the right fix depends on a choice only the owner can make (which of two
behaviours he wants, whether something is worth changing at all), do not
guess. Commit what is safe either way (or nothing), use \`OUTCOME: question\`,
and add this section to the report:

    ## Question

    One plain-language question, no code words, file names or backticks.

    A) First choice, in a few words
    B) Second choice
    C) (optional, at most E)

The card waits until he answers with one letter; the next run gets his answer.

## Your last step: write ${reportPath}

Line 1 exactly \`OUTCOME: fixed\`, \`OUTCOME: gave-up\`, \`OUTCOME: needs-human\` or \`OUTCOME: question\`.
Then a blank line, then a plain-language summary for the owner and the CX team:
three to six short sentences, no code words, saying what was wrong for the
florist, client or team, what you changed, and how you know it works. Then the
sections "What the tests show" (the failing run and the passing run, named),
"Decisions" (plain questions with options A/B/C, or "None"), and "Appendix"
(commits, files, commands). If you committed nothing, the summary says why.
`;
}

// report.md -> {outcome, body}. A missing or malformed first line is null.
export function parseReport(text) {
  if (!text?.trim()) return { outcome: null, body: "" };
  const [first, ...rest] = text.replace(/^﻿/, "").split(/\r?\n/);
  const m = /^OUTCOME:\s*([a-z-]+)\s*$/i.exec(first.trim());
  const outcome = m && OUTCOMES.includes(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
  return { outcome, body: (outcome ? rest.join("\n") : text).trim() };
}

export const VIDEO_RE = /\.(webm|mp4|mov)$/i;

export const touchedProtected = (files) =>
  files.filter((f) => PROTECTED_PATHS.some((p) => f === p || f.startsWith(p)));

// What a finished box means. `commits` is how many commits the agent left on
// its branch, `files` the paths they change, `timedOut` the wall-clock cap.
//
//   no report or timed out      -> failed       card open   no PR
//   commits, protected path     -> needs-human  in-progress PR
//   commits                     -> agent's word in-progress PR
//   no commits, needs-human     -> needs-human  in-progress no PR
//   no commits                  -> gave-up      open        no PR
//
// `doctor`: a run of the doctor lane. The factory changing itself is always
// needs-human when it commits.
//
// Free lane (`automerge` on, outcome fixed, only FREE_PATHS, not a doctor run,
// at least one screenshot or video in `evidence`): ready PR, `merge: true`.
//
// Every card with a PR stays in-progress, merged or not: it goes done once its
// rule has been quiet 7 days after the merge (quietCards in general-rules.mjs),
// not when a run ends.
//
// OUTCOME question (the agent was not sure): judged like needs-human, then the
// card waits for the owner (WAITING) with the question on the decision. With
// commits the draft PR carries the question; without, `askIssue` tells publish
// to open a GitHub issue for it. A question the factory cannot read (no plain
// text, no lettered choices) stays a plain needs-human, as before.
export function decide(input) {
  const { outcome, body } = parseReport(input.report);
  if (outcome !== "question" || input.timedOut) return decideRun(input);
  const question = parseQuestion(body);
  const d = decideRun({ ...input, report: `OUTCOME: needs-human\n\n${body}` });
  if (d.outcome === "failed") return d;
  if (!question) return { ...d, notes: `Asked a question that could not be read (it needs plain words and lettered choices A, B...). ${d.notes}`.trim() };
  return { ...d, outcome: "question", cardStatus: WAITING, merge: false, question, askIssue: !d.openPr, notes: `Asked the owner: ${question.text}` };
}

function decideRun({ report, commits, files = [], timedOut = false, boxExit = 0, doctor = false, evidence = [], automerge = false }) {
  const { outcome, body } = parseReport(report);
  if (timedOut) return { outcome: "failed", cardStatus: "open", openPr: false, notes: "Stopped at the time cap before finishing." };
  if (!outcome) {
    const why = boxExit === 0 ? "The agent ended without a valid report.md." : `The box exited with code ${boxExit} and no valid report.`;
    return { outcome: "failed", cardStatus: "open", openPr: false, notes: why };
  }
  if (commits > 0) {
    // Videos live in the factory-out artifact, never in git.
    const videos = files.filter((f) => VIDEO_RE.test(f));
    if (videos.length) return { outcome: "failed", cardStatus: "open", openPr: false, notes: `Committed a video, which never goes into git: ${videos.join(", ")}` };
    const guarded = touchedProtected(files);
    if (guarded.length) {
      return { outcome: "needs-human", cardStatus: "in-progress", openPr: true, guarded, doctor, notes: `Touches protected paths: ${guarded.join(", ")}` };
    }
    if (doctor) return { outcome: "needs-human", cardStatus: "in-progress", openPr: true, guarded, doctor, notes: `Doctor PR: the factory changing itself always needs a person. ${firstParagraph(body)}`.trim() };
    const proof = evidence.some((f) => VIDEO_RE.test(f) || /\.png$/i.test(f));
    if (automerge && outcome === "fixed" && proof && freeLane(files)) {
      return { outcome, cardStatus: "in-progress", openPr: true, merge: true, guarded: [], notes: `Free lane: merged on its own. ${firstParagraph(body)}`.trim() };
    }
    return { outcome, cardStatus: "in-progress", openPr: true, guarded: [], notes: firstParagraph(body) };
  }
  if (outcome === "needs-human") return { outcome, cardStatus: "in-progress", openPr: false, notes: firstParagraph(body) };
  return { outcome: "gave-up", cardStatus: "open", openPr: false, notes: firstParagraph(body) || "No change and no reason given." };
}

// A factory card back to open after its last doctor try is parked instead.
export function parkIfSpent(d, tries) {
  if (d.cardStatus !== "open" || tries < DOCTOR_TRIES) return d;
  return { ...d, cardStatus: "parked", notes: `${d.notes} Parked after ${DOCTOR_TRIES} doctor tries; a person decides.` };
}

// The factory-good tag marks the last executor that ran clean: fixed, or no
// change and no failure. Only the garden executor moves it, so the doctor
// (which runs from the tag) and test branches never do.
export function moveGoodTag({ executorRef, outcome, commits }) {
  if (executorRef !== "garden") return false;
  return outcome === "fixed" || (commits === 0 && outcome !== "failed");
}

// box/run.sh runs claude under `timeout`, which exits 124 at the cap.
export const timedOutExit = (claudeExit) => Number(claudeExit) === 124;

// The last `result` line of Claude Code's stream-json log: what the run cost.
export function agentUsage(jsonl) {
  const last = (jsonl ?? "").split("\n").reverse().map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).find((m) => m?.type === "result");
  return last ? { costUsd: last.total_cost_usd ?? null, turns: last.num_turns ?? null, stop: last.subtype ?? null } : null;
}

const firstParagraph = (body) => body.split(/\n\s*\n/)[0].trim().slice(0, 1000);

export function prTitle(card) {
  return `factory(${card.agent}): ${card.title.replace(/^[^:]+:\s*/, "")}`.slice(0, 120);
}

// The Actions run that holds the factory-out artifact; null off GitHub.
export function actionsRunUrl(env) {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: id } = env;
  return server && repo && id ? `${server}/${repo}/actions/runs/${id}` : null;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Line 1 of every PR: where the video and screenshots are (`evidence` lists
// the files under out/evidence/), and what the protected-path gate said.
export function evidenceLine({ runUrl, evidence = [], decision }) {
  const videos = evidence.filter((f) => VIDEO_RE.test(f)).length;
  const shots = evidence.filter((f) => /\.png$/i.test(f)).length;
  const what = videos || shots ? `${plural(videos, "video")}, ${plural(shots, "screenshot")}` : "no video or screenshots (tests only)";
  const where = runUrl ? `the [Actions run](${runUrl}) (artifact \`factory-out\`, folder \`evidence/\`)` : "the run's `out/evidence/` folder";
  const gate = decision.guarded?.length ? "needs a person (protected paths)" : decision.doctor ? "needs a person (doctor PR)"
    : decision.question ? "waiting for the owner's answer" : decision.merge ? "passed, free lane (merges itself)" : "passed";
  return `**Evidence:** ${what} in ${where}. **Gate:** ${gate}, outcome \`${decision.outcome}\`.`;
}

// `check`: the card manager's line (managers.mjs checkLine), if it has one.
export function prBody({ card, report, decision, run, runUrl = null, evidence = [], graph = "", part = "", check = "" }) {
  const { body } = parseReport(report);
  const warn = decision.guarded?.length
    ? `**Needs a person: this touches ${decision.guarded.map((p) => `\`${p}\``).join(", ")}, which no factory agent changes alone.**\n\n`
    : decision.doctor ? "**Needs a person: a doctor PR changes the factory itself, which never ships alone.**\n\n" : "";
  const ask = decision.question ? `${questionBlock(decision.question)}\n\n` : "";
  return `${evidenceLine({ runUrl, evidence, decision })}

${check ? `${check}\n\n` : ""}${part ? `${part}\n\n` : ""}${warn}${ask}${graph ? `${graph}\n\n<details><summary>The agent's notes</summary>\n\n${body}\n\n</details>` : body}

---

Factory card \`${card.id}\` (${card.agent}, ${card.source}), run \`${run.id}\`, outcome \`${decision.outcome}\`.
Opened by \`agents/factory/execute-card.mjs\` from a locked sandbox. ${decision.merge
    ? "Free lane (wording or look only, gate passed, evidence attached): the factory merges it into garden."
    : "Draft: a person reviews and merges; the factory never merges."}

🤖 Generated with [Claude Code](https://claude.com/claude-code)
`;
}

// The owner reviews a PR from a picture, not prose (2026-10-22): a Mermaid graph
// of the changed files, one box per file grouped by folder, sized in the label
// and coloured by risk. GitHub renders it with zoom and pan; each box links to
// the file's diff. Above PR_LINE_LIMIT changed lines the work is split in two.
export const PR_LINE_LIMIT = 1000;

// `git diff --numstat` -> [{ file, added, deleted }]. Binary files count 0.
export const parseNumstat = (text) =>
  text.split("\n").filter(Boolean).map((l) => {
    const [a, d, ...f] = l.split("\t");
    return { file: f.join("\t"), added: Number(a) || 0, deleted: Number(d) || 0 };
  });

export const changedLines = (stats) => stats.reduce((n, s) => n + s.added + s.deleted, 0);

// Per-commit line counts, oldest first -> how many commits go in the first PR,
// or null when no prefix of whole commits fits under the limit (one big commit).
export function splitPoint(commitLines, limit = PR_LINE_LIMIT) {
  if (commitLines.reduce((a, b) => a + b, 0) <= limit) return null;
  let total = 0, n = 0;
  while (n < commitLines.length - 1 && total + commitLines[n] <= limit) total += commitLines[n++];
  return n > 0 ? n : null;
}

const folderOf = (file) => file.split("/").slice(0, -1).slice(0, 2).join("/") || ".";
const mermaidText = (s) => s.replace(/["<>]/g, "'");

// linkFor(file) -> URL of that file's diff. Returns the markdown block.
export function changeGraph(stats, linkFor) {
  const groups = new Map();
  stats.forEach((s, i) => {
    const g = folderOf(s.file);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ ...s, id: `f${i}` });
  });
  const lines = ["flowchart LR"];
  [...groups.entries()].forEach(([g, files], gi) => {
    lines.push(`  subgraph g${gi}["${mermaidText(g)}"]`);
    for (const f of files) {
      const kind = touchedProtected([f.file]).length ? "risky" : freeLane([f.file]) ? "free" : "code";
      lines.push(`    ${f.id}["${mermaidText(f.file.split("/").at(-1))}<br/>+${f.added} −${f.deleted}"]:::${kind}`);
    }
    lines.push("  end");
  });
  stats.forEach((s, i) => lines.push(`  click f${i} "${linkFor(s.file)}" _blank`));
  lines.push(
    "  classDef risky fill:#fbe3e1,stroke:#b3261e,color:#18241c",
    "  classDef free fill:#e1ede3,stroke:#2f6b45,color:#18241c",
    "  classDef code fill:#e2ecf6,stroke:#2f5d86,color:#18241c",
  );
  const total = changedLines(stats);
  return `**${stats.length} files, +${stats.reduce((n, s) => n + s.added, 0)} −${stats.reduce((n, s) => n + s.deleted, 0)} (${total} lines).** Red: needs a person · green: wording/look · blue: code. Click a box for its diff.

\`\`\`mermaid
${lines.join("\n")}
\`\`\``;
}

// GitHub's anchor for one file in a PR's "Files changed" tab.
export const diffAnchor = (prUrl, file, sha256) => `${prUrl}/files#diff-${sha256(file)}`;

// The verify map grows after each merge (factory-after-merge.yml). `pulls` is
// GitHub's commits/{sha}/pulls for the pushed garden commit: it also lists open
// PRs that merely contain the commit, so only the card PR that this commit
// merged counts.
export const VERIFY_DIR = ".claude/skills/verify/";
export const VERIFY_LABEL = "verify-map";

export const mergedCardPr = (pulls, sha) =>
  pulls.find((p) => p.merged_at && p.merge_commit_sha === sha && CARD_BRANCH.test(p.head?.ref ?? "")) ?? null;

export function verifyMapPrompt({ pr, files }) {
  const list = files.map((f) => `- ${f}`).join("\n");
  return `Factory card PR #${pr.number} ("${pr.title}") was just merged into garden. It changed:

${list}

Run the pstack:maintain-verification-skill skill on .claude/skills/verify/, scoped to
these files: does any user-facing feature they touch need a new or corrected entry in
features/ (or a recipe in recipes/)? There is no running dashboard here, so do the
source pass only and skip the live pass; say so in what you write.

Edit only files under .claude/skills/verify/ (never evidence/ or node_modules/). Keep
any change small and cite the source path it comes from. If nothing needs updating,
change nothing. Do not commit or push. End with one or two plain sentences on what you
changed and why, or "nothing to update".`;
}

// Owner memory (same workflow): each merged card PR adds one dated fact under
// "## Learned" in its agent's agents/thinking/<agent>.md, newest LEARNED_CAP
// kept. Facts only, never rules (the owner, 2026-10-16: no self-written rules).
// The fact is the PR title without its "factory(<agent>): " prefix.
export const LEARNED_CAP = 20;
const LEARNED = "## Learned";

// factory/card-<id8> -> the uuid range holding that card (uuid has no LIKE).
export function cardIdRange(ref) {
  const m = CARD_BRANCH.exec(ref ?? "");
  return m ? [`${m[1]}-0000-0000-0000-000000000000`, `${m[1]}-ffff-ffff-ffff-ffffffffffff`] : null;
}

// The agent named in a "factory(<agent>): ..." title; the fallback when the
// card row cannot be read.
export const titleAgent = (title) => /^factory\(([a-z]+)\):/.exec(title ?? "")?.[1] ?? null;

export function learnedLine(pr) {
  const fact = pr.title.replace(/^factory\([^)]*\):\s*/, "").replace(/\s+/g, " ").trim();
  return `- ${pr.merged_at.slice(0, 10)}: ${fact} (PR #${pr.number})`;
}

// Appends `line` under ## Learned (made at the end if missing), drops an
// identical older copy so a rerun does not repeat it, keeps the newest `cap`.
export function appendLearned(text, line, cap = LEARNED_CAP) {
  const lines = text.replace(/\s+$/, "").split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === LEARNED);
  if (start < 0) return [...lines, "", LEARNED, "", line, ""].join("\n");
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const facts = [...lines.slice(start + 1, end).filter((l) => l.startsWith("- ") && l !== line), line].slice(-cap);
  const tail = lines.slice(end);
  return [...lines.slice(0, start + 1), "", ...facts, ...(tail.length ? ["", ...tail] : []), ""].join("\n");
}
