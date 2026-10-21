// Pure half of the card executor (execute-card.mjs): which card to work, the
// brief the boxed agent gets, and what a finished run means. No I/O, so
// executor.test.mjs drives it with plain objects.

export const MAX_TRIES = 5;
export const COOL_OFF_MS = 24 * 3600_000;
// A run with no finished_at older than this was killed with its host (laptop
// asleep, power cut). The next executor closes it so the card can be retried.
export const STALE_RUN_MS = 3 * 3600_000;

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

const OUTCOMES = ["fixed", "gave-up", "needs-human"];

export const branchFor = (card) => `factory/card-${card.id.slice(0, 8)}`;

// cards: open factory_tasks rows, each with runs: [{id, started_at, finished_at}].
export function staleRuns(cards, now) {
  return cards.flatMap((c) => c.runs)
    .filter((r) => !r.finished_at && now - Date.parse(r.started_at) > STALE_RUN_MS)
    .map((r) => r.id);
}

// Oldest open card that nobody is working, that has not used its tries, and
// that was not tried in the last day (a card that keeps failing must not eat
// every slot).
export function pickCard(cards, now) {
  const eligible = cards.filter((c) => {
    if (c.status !== "open") return false;
    if (c.runs.some((r) => !r.finished_at)) return false;
    if (c.runs.length >= MAX_TRIES) return false;
    const last = Math.max(0, ...c.runs.map((r) => Date.parse(r.started_at)));
    return now - last >= COOL_OFF_MS;
  });
  eligible.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id));
  return eligible[0] ?? null;
}

export function buildPrompt({ card, agentFile, base, branch, reportPath = "/out/report.md" }) {
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

## The agent you are improving: agents/thinking/${card.agent}.md

\`\`\`markdown
${agentFile.trim()}
\`\`\`

## Where you are

A fresh clone of the repo at \`${base}\`, on branch \`${branch}\`, inside a locked
sandbox. You have the code and npm. You have no database, no secrets, no
GitHub and no remote: you cannot query the rows above, only reason from the
evidence, the code and the docs (progress.md lists cracks the garden found,
some may match this card). Nobody is watching and nobody will answer.

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
   Scratch notes go under docs/agent-factory/tasks/card-${card.id.slice(0, 8)}/, never .claude/.
7. Never use run_in_background and never end your turn to wait.
8. If the evidence is stale, already fixed in the code, or not a code problem,
   say so plainly and commit nothing. That is a valid result.

## Your last step: write ${reportPath}

Line 1 exactly \`OUTCOME: fixed\`, \`OUTCOME: gave-up\` or \`OUTCOME: needs-human\`.
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
// A card with a PR stays in-progress: it goes done when the sweep stops seeing
// its signal (agents/factory/README.md), not when a run ends.
export function decide({ report, commits, files = [], timedOut = false, boxExit = 0 }) {
  const { outcome, body } = parseReport(report);
  if (timedOut) return { outcome: "failed", cardStatus: "open", openPr: false, notes: "Stopped at the time cap before finishing." };
  if (!outcome) {
    const why = boxExit === 0 ? "The agent ended without a valid report.md." : `The box exited with code ${boxExit} and no valid report.`;
    return { outcome: "failed", cardStatus: "open", openPr: false, notes: why };
  }
  if (commits > 0) {
    const guarded = touchedProtected(files);
    if (guarded.length) {
      return { outcome: "needs-human", cardStatus: "in-progress", openPr: true, guarded, notes: `Touches protected paths: ${guarded.join(", ")}` };
    }
    return { outcome, cardStatus: "in-progress", openPr: true, guarded: [], notes: firstParagraph(body) };
  }
  if (outcome === "needs-human") return { outcome, cardStatus: "in-progress", openPr: false, notes: firstParagraph(body) };
  return { outcome: "gave-up", cardStatus: "open", openPr: false, notes: firstParagraph(body) || "No change and no reason given." };
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

export function prBody({ card, report, decision, run }) {
  const { body } = parseReport(report);
  const warn = decision.guarded?.length
    ? `**Needs a person: this touches ${decision.guarded.map((p) => `\`${p}\``).join(", ")}, which no factory agent changes alone.**\n\n`
    : "";
  return `${warn}${body}

---

Factory card \`${card.id}\` (${card.agent}, ${card.source}), run \`${run.id}\`, outcome \`${decision.outcome}\`.
Opened by \`agents/factory/execute-card.mjs\` from a locked sandbox. Draft: a person reviews and merges; the factory never merges.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
`;
}
