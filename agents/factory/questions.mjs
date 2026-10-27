// Pure half of "when the agent is not sure, it asks the owner and waits".
// No I/O, so questions.test.mjs drives it with plain strings and objects.
//
// 1. The agent ends with `OUTCOME: question` and a "## Question" section: one
//    plain-language question and two to five lettered choices (A, B, C...),
//    the owner's preference for every question the factory puts to him.
// 2. publish (execute-card.mjs) stores it on the card, puts it at the top of
//    the draft PR (or a GitHub issue when there is no code yet) and sets the
//    card to WAITING. The executor only picks `open` cards, so it skips it.
// 3. The owner replies where he already looks, the PR or the issue, with a line
//    like `answer: B` (a note may follow). The sweep reads those comments,
//    and the first answer from a person reopens the card.
// 4. The next brief carries the question and his pick (answerBrief).

export const WAITING = "waiting_for_answer";
export const MAX_CHOICES = 5;
const LETTERS = "ABCDEFGHIJ";

// Commenters whose reply counts: people with a say in the repo, never a bot
// (the factory's own token posts as github-actions[bot]).
const PEOPLE = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const section = (body, name) => {
  const lines = String(body ?? "").split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^#{2,3}\\s*${name}\\s*$`, "i").test(l.trim()));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^#{1,3}\s/.test(l.trim()));
  return lines.slice(start + 1, end < 0 ? lines.length : end);
};

const CHOICE_RE = /^(?:[-*]\s*)?\(?([A-J])[).:]\s+(.+)$/;
// Not plain language: code spans, file paths, function calls.
const CODE_RE = /`|\b[\w-]+\/[\w./-]+\.\w+\b|\w+\(\)/;

/** report body -> {text, choices: [{letter, text}]}, or null when there is no
 * question the owner could answer with one letter. */
export function parseQuestion(body) {
  const lines = section(body, "Question");
  if (!lines) return null;
  const text = [];
  const choices = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    const m = CHOICE_RE.exec(l);
    if (m) choices.push({ letter: m[1], text: m[2].trim() });
    else if (!choices.length) text.push(l);
  }
  const question = text.join(" ").trim();
  if (!question || choices.length < 2 || choices.length > MAX_CHOICES) return null;
  if (choices.some((c, i) => c.letter !== LETTERS[i])) return null;
  if ([question, ...choices.map((c) => c.text)].some((s) => CODE_RE.test(s))) return null;
  return { text: question, choices };
}

/** The question as it appears at the top of the PR or issue. */
export function questionBlock(q) {
  return `**A question for the owner: the agent was not sure and is waiting for your answer.**

${q.text}

${q.choices.map((c) => `- **${c.letter}** ${c.text}`).join("\n")}

Reply on this page with one line, for example \`answer: B\` (a note after it is passed on too). The card waits until then.`;
}

/** A run that asks before writing any code has no PR to put the question on,
 * so publish opens a GitHub issue with this title and body. */
export function questionIssue({ card, question, run, runUrl = null }) {
  const title = `Question: ${card.title.replace(/^[^:]+:\s*/, "")}`.slice(0, 200);
  const body = `${questionBlock(question)}

---

What the card is about: ${card.summary}

Factory card \`${card.id}\` (${card.agent}, ${card.source}), run \`${run.id}\`${runUrl ? `, [Actions run](${runUrl})` : ""}. Opened by \`agents/factory/execute-card.mjs\`; the sweep reads your answer here.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
`;
  return { title, body };
}

const ANSWER_RE = /^\s*answer\s*[:=-]?\s*([A-Za-z])(?![A-Za-z])[\s,.;:-]*(.*)$/im;

/** One comment -> {letter, note}, or null when it holds no answer line naming
 * one of the choices. */
export function parseAnswer(text, choices) {
  const m = ANSWER_RE.exec(String(text ?? ""));
  if (!m) return null;
  const letter = m[1].toUpperCase();
  if (!choices.some((c) => c.letter === letter)) return null;
  return { letter, note: m[2].trim() || null };
}

/** GitHub issue comments (oldest first or not) -> the first answer a person
 * gave after the question was asked, or null. */
export function findAnswer(comments, question) {
  const after = Date.parse(question.asked_at ?? 0);
  const sorted = [...comments].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  for (const c of sorted) {
    if (Date.parse(c.created_at) <= after) continue;
    if (c.user?.type === "Bot" || !PEOPLE.has(c.author_association)) continue;
    const a = parseAnswer(c.body, question.choices);
    if (!a) continue;
    const choice = question.choices.find((x) => x.letter === a.letter).text;
    return { letter: a.letter, choice, note: a.note, by: c.user?.login ?? null, at: c.created_at, url: c.html_url ?? null };
  }
  return null;
}

/** A PR or issue URL -> {repo, number}; PR comments live on the issue API. */
export function issueRef(url) {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/.exec(url ?? "");
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/** The card row patch that resumes a waiting card. The question stays, so the
 * next brief can quote it. */
export function resumePatch(card, answer, now = new Date().toISOString()) {
  return { status: "open", answer: { ...answer, round: card.question?.round ?? 1 }, updated_at: now };
}

/** The brief section for an answered card; empty when the newest question is
 * still unanswered or there never was one. */
export function answerBrief(card) {
  const q = card.question;
  const a = card.answer;
  if (!q || !a || (a.round ?? 1) !== (q.round ?? 1)) return "";
  return `## The owner answered your question

A previous run on this card stopped to ask:

> ${q.text}
${q.choices.map((c) => `> ${c.letter}) ${c.text}`).join("\n")}

He chose ${a.letter}: ${a.choice}.${a.note ? ` His note: "${a.note}".` : ""}
Work from that answer. Do not ask the same question again.

`;
}
