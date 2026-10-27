// Pure half of the managers (garden 1.2, "Chain of command"): who owns a card,
// the brief that says what "fixed" means, the check of Mike's work against
// it, and the events each step leaves in agent_events (case_id card:<id>).
// No I/O; execute-card.mjs runs the steps, managers.test.mjs drives this.
//
//   1. Brief  the owning manager writes what "fixed" means      brief_written, sent_to_mike
//   2. Code   Mike (the factory worker) makes the change
//   3. Check  the manager checks it against its own brief       check_passed | sent_back |
//             Mike never marks his own work                     dropped_as_designed | to_jessica
//             (Mike asked a question: no check, straight to_jessica; questions.mjs)
//   4. Rule   the card closes only after CARD_LIFE.quietDays quiet days (general-rules.mjs)
//
// Who owns which general rule (general-rules.json `owner`) and a card's life
// (CARD_LIFE) live in general-rules.mjs; this file only adds what a manager
// reads and how it briefs and checks.

import { CARD_LIFE, MANAGERS as CAST, RULES } from "./general-rules.mjs";

const rulesOf = (id) => RULES.filter((r) => r.owner === id).map((r) => r.id);

// Promoted roles: each reads existing agents' files (agents/thinking/) as
// knowledge; the agents themselves do not change. Role prose lives in
// agents/factory/managers/<id>.md. Their rules come from general-rules.json.
const role = (id, title, reads) => Object.freeze({ ...CAST[id], role: title, reads, rules: rulesOf(id) });
export const MANAGERS = Object.freeze({
  harvey: role("harvey", "Supply manager", ["scout", "bloom", "sherlock", "cupid", "quill", "polyglot"]),
  donna: role("donna", "Order-loop manager", ["concierge", "babel", "planner", "oracle"]),
  louis: role("louis", "Proof manager", ["hawkeye"]),
});

// Jessica is the human in the loop (the owner). Money stays with her: she briefs
// and checks every payout fix herself, so her cards never go to Mike.
export const JESSICA = Object.freeze({ id: "jessica", name: CAST.jessica.name, rules: rulesOf("jessica") });

// A card sent back this many times goes to Jessica on the next send-back.
export const MAX_SEND_BACKS = 2;

export const VERDICTS = ["passed", "sent-back", "dropped-as-designed", "to-jessica"];

export const caseId = (card) => `card:${card.id}`;
export const generalRule = (card) => card.general_rule ?? card.evidence?.general_rule ?? null;
export const managerName = (id) => (id === JESSICA.id ? JESSICA.name : MANAGERS[id]?.name ?? id);

// A card on a general rule belongs to that rule's owner. Older cards name only
// an agent: the manager that reads that agent's file owns it. Error cards are
// the order loop's code (Donna); factory cards are the doctor lane (nobody).
export function managerFor(card) {
  const rule = generalRule(card);
  if (rule) {
    if (JESSICA.rules.includes(rule)) return JESSICA.id;
    return Object.keys(MANAGERS).find((id) => MANAGERS[id].rules.includes(rule)) ?? null;
  }
  if (card.source === "factory") return null;
  if (card.source === "error") return "donna";
  return Object.keys(MANAGERS).find((id) => MANAGERS[id].reads.includes(card.agent)) ?? null;
}

// The card's agent_events (oldest first) -> what the manager knows already:
// the newest brief, how often Mike was sent back since it, and whether the
// card was reopened after it (a reopened card gets a fresh brief version).
export function managerState(events) {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let brief = null, briefSeq = -1, version = 0;
  for (const e of sorted) {
    if (e.type !== "brief_written") continue;
    brief = { version: e.data.version, text: e.data.brief };
    briefSeq = e.seq;
    version = Math.max(version, e.data.version ?? 0);
  }
  const after = sorted.filter((e) => e.seq > briefSeq);
  const sentBack = after.filter((e) => e.type === "sent_back");
  const reopened = after.some((e) => e.type === "reopened");
  return {
    brief: reopened ? null : brief,
    nextVersion: version + 1,
    sendBacks: reopened ? 0 : sentBack.length,
    lastReason: reopened ? null : sentBack.at(-1)?.data.reason ?? null,
  };
}

const fence = (text) => `\`\`\`\n${String(text ?? "").trim()}\n\`\`\``;

function cardBlock(card) {
  return `- Title: ${card.title}
- What is wrong: ${card.summary}
- Source: ${card.source}; agent: ${card.agent}; general rule: ${generalRule(card) ?? "none named"}
- Evidence:

${fence(JSON.stringify(card.evidence ?? {}, null, 2))}`;
}

export function briefPrompt({ card, manager, roleFile, agentFile = "", version = 1 }) {
  const m = MANAGERS[manager];
  const knowledge = m.reads.map((a) => `agents/thinking/${a}.md`).join(", ");
  return `You are ${m.name}, the ${m.role} of the Facundo agent factory. Your role file:

${fence(roleFile)}

## The card you own

${cardBlock(card)}

${agentFile ? `## The agent this card names (agents/thinking/${card.agent}.md)\n\n${fence(agentFile)}\n\n` : ""}## Your job now: brief ${version}

Mike, the one coding agent, will work this card next. He will read your brief
and nothing else from you. Write what "fixed" means for this card, so you can
check his work against it later. You may read the repo (your knowledge:
${knowledge}; also CLAUDE.md, docs/agent-factory/garden.md,
dashboard/lib/lifecycle.ts). Do not change any file.

The card itself closes only when its rule stays quiet for ${CARD_LIFE.quietDays} days after the
fix is merged, so "fixed" must be something that makes the alerts stop, not a
nicer message about them. If the evidence shows the system working as
designed, say so: then "fixed" means changing nothing.

Reply with the brief only, in this shape and nothing before it:

## Fixed means
One to three plain sentences.

## Check
Three to six bullets you will verify in Mike's change (a test that fails
before and passes after, which behaviour changes, what must not change).

## Out of scope
What Mike must not touch for this card.
`;
}

// The manager's reply -> the brief text, or null when it is not a brief.
export function parseBrief(text) {
  const i = (text ?? "").indexOf("## Fixed means");
  if (i < 0) return null;
  const brief = text.slice(i).trim();
  return brief.length > 40 ? brief.slice(0, 6000) : null;
}

// Appended to Mike's prompt: the brief, and the reason he was sent back.
export function briefSection({ manager, brief, lastReason = null }) {
  const name = managerName(manager);
  const back = lastReason
    ? `\n## Sent back last time\n\n${name} checked your previous try against this brief and sent it back:\n\n> ${lastReason.replace(/\n/g, "\n> ")}\n\nStart again from the base branch and fix exactly that.\n`
    : "";
  return `
## Your manager's brief (${name}, version ${brief.version})

${name} owns this card. When you finish, ${name} checks your commits and your
report against this brief; you do not decide whether it passes. Where this
brief and the card disagree, the brief wins. Rules 1 to 8 above still hold.

${brief.text}
${back}`;
}

export function checkPrompt({ card, manager, roleFile, brief, report, commits }) {
  const m = MANAGERS[manager];
  return `You are ${m.name}, the ${m.role} of the Facundo agent factory. Your role file:

${fence(roleFile)}

## The card you own

${cardBlock(card)}

## Your brief (version ${brief.version})

${brief.text}

## What Mike did

Mike left ${commits} commit(s). His changes are \`git diff refs/factory/base refs/heads/factory-result\`
in this folder (\`git log\` and \`git show\` work too). Read them; do not change
any file and do not run tests (the factory runs them). His report:

${fence(report || "(no report)")}

## Your job now: check his work against YOUR brief

Mike never marks his own work; you do. Choose one:

- \`passed\`: his commits do what "Fixed means" says and every "Check" bullet holds.
- \`sent-back\`: they do not, or he committed nothing and there is something to fix. Give him the reason he needs to fix it, in one or two sentences.
- \`dropped-as-designed\`: the evidence is the system doing what its rules require; nothing should change. Name the situation id from dashboard/lib/lifecycle.ts it falls under.
- \`to-jessica\`: it needs a person (money, a Shopify write, sign-in, or you cannot tell). Say why.

Reply with these lines and nothing before them:

VERDICT: <passed|sent-back|dropped-as-designed|to-jessica>
REASON: <one or two plain sentences>
BRANCH: <situation id, only for dropped-as-designed>
`;
}

// The manager's reply -> { verdict, reason, branch }, or null when unreadable.
export function parseVerdict(text) {
  const line = (k) => new RegExp(`^\\s*${k}:\\s*(.+)$`, "im").exec(text ?? "")?.[1].trim() ?? null;
  const verdict = line("VERDICT")?.toLowerCase().replace(/[`*]/g, "");
  if (!VERDICTS.includes(verdict)) return null;
  const branch = line("BRANCH");
  return { verdict, reason: line("REASON") ?? "", branch: branch && !/^(none|n\/a|-)$/i.test(branch) ? branch : null };
}

// What the check does to executor.mjs's decide() result, and the events it
// logs. `m`: { manager, brief, verdict, sendBacks }; null for a card nobody
// manages (the decision is unchanged). Only `passed` keeps the free lane.
export function applyCheck(d, m) {
  if (!m?.manager) return { decision: d, events: [] };
  const name = managerName(m.manager);
  if (!m.brief) return { decision: { ...d, openPr: false, merge: false, cardStatus: "open", notes: `${name} wrote no brief, so the card did not go to Mike. ${d.notes}`.trim() }, events: [] };
  if (d.outcome === "failed") return { decision: d, events: [] };
  // Mike was not sure and asked (questions.mjs): there is no work to check, the
  // question goes to Jessica (the owner) and the card waits for his answer.
  if (d.outcome === "question") return { decision: d, events: [{ type: "to_jessica", data: { why: `Mike asked: ${d.question.text}`, question: d.question } }] };
  const toPerson = (why, extra = []) => ({
    decision: { ...d, outcome: "needs-human", cardStatus: "in-progress", merge: false, notes: `${name} sent it to Jessica: ${why} ${d.notes}`.trim() },
    events: [...extra, { type: "to_jessica", data: { why } }],
  });
  const v = m.verdict;
  if (!v) return toPerson(`${name}'s check did not finish, so a person checks it.`);
  if (v.verdict === "passed") {
    const events = [{ type: "check_passed", data: { reason: v.reason } }];
    if (d.guarded?.length) events.push({ type: "to_jessica", data: { why: `touches protected paths: ${d.guarded.join(", ")}` } });
    else if (d.outcome === "needs-human") events.push({ type: "to_jessica", data: { why: d.notes } });
    return { decision: d, events };
  }
  if (v.verdict === "sent-back") {
    const sent = { type: "sent_back", data: { reason: v.reason } };
    if ((m.sendBacks ?? 0) >= MAX_SEND_BACKS) return toPerson(`sent back ${(m.sendBacks ?? 0) + 1} times; last reason: ${v.reason}`, [sent]);
    return { decision: { ...d, openPr: false, merge: false, cardStatus: "open", notes: `Sent back by ${name}: ${v.reason}` }, events: [sent] };
  }
  if (v.verdict === "dropped-as-designed") {
    return {
      decision: { ...d, openPr: false, merge: false, cardStatus: "dropped", notes: `Dropped as designed by ${name}${v.branch ? ` (${v.branch})` : ""}: ${v.reason}` },
      events: [{ type: "dropped_as_designed", data: { branch: v.branch, reason: v.reason } }],
    };
  }
  return toPerson(v.reason);
}

// One line under the PR's evidence line saying what the manager decided.
export function checkLine(m, d) {
  if (!m?.manager || !m.brief) return "";
  // The question block (questions.mjs) already leads the PR.
  if (d.outcome === "question") return "";
  const name = managerName(m.manager);
  if (m.verdict?.verdict === "passed") return `**Check:** ${name} passed it against brief v${m.brief.version}: ${m.verdict.reason}`;
  return `**Needs a person:** ${d.notes}`;
}

// Events -> agent_events rows after `lastSeq`, each stamped with the manager
// and the run. An event's own `at` (when it happened) becomes created_at, else
// `now`; every row carries it, since a bulk insert takes its columns from row 1.
export function eventRows(card, lastSeq, events, { manager, runId, now }) {
  return events.map((e, i) => ({
    case_id: caseId(card),
    seq: lastSeq + 1 + i,
    type: e.type,
    data: { manager, run_id: runId, ...e.data },
    created_at: e.at ?? now,
  }));
}
