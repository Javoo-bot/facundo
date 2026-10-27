// node --test agents/factory/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WAITING, parseQuestion, questionBlock, parseAnswer, findAnswer, issueRef, answerBrief, resumePatch, questionIssue } from "./questions.mjs";
import { DAY_MS, quietCards, ruleCardPlan } from "./general-rules.mjs";
import { applyCheck, checkLine } from "./managers.mjs";

const report = `The reminder could go out at two times and both look right.

## Question

Should the florist reminder go out in the morning or the evening?

A) In the morning, at 9:00
B) In the evening, at 18:00
C) Do not send a reminder

## What the tests show

None yet.`;

const Q = { text: "Should the florist reminder go out in the morning or the evening?", choices: [
  { letter: "A", text: "In the morning, at 9:00" },
  { letter: "B", text: "In the evening, at 18:00" },
  { letter: "C", text: "Do not send a reminder" },
] };

test("the waiting status is one named value", () => {
  assert.equal(WAITING, "waiting_for_answer");
});

test("a question is read from its own section: plain text and lettered choices", () => {
  assert.deepEqual(parseQuestion(report), Q);
  // Other ways an agent writes the letters.
  const dashed = "## Question\nWhich one?\n- A. First\n- B: Second\n";
  assert.deepEqual(parseQuestion(dashed), { text: "Which one?", choices: [{ letter: "A", text: "First" }, { letter: "B", text: "Second" }] });
});

test("a question the factory cannot put to the owner is refused", () => {
  assert.equal(parseQuestion("No question section here."), null);
  assert.equal(parseQuestion("## Question\nWhich one?\nA) Only one choice\n"), null, "one choice is not a choice");
  assert.equal(parseQuestion("## Question\nWhich one?\nA) x\nC) y\n"), null, "letters skip B");
  assert.equal(parseQuestion("## Question\nA) x\nB) y\n"), null, "no question text");
  assert.equal(parseQuestion("## Question\nShould `sendOffer` retry?\nA) yes\nB) no\n"), null, "code words are not plain language");
  const six = "## Question\nWhich?\n" + "ABCDEF".split("").map((l) => `${l}) ${l}`).join("\n");
  assert.equal(parseQuestion(six), null, "more than five choices");
});

test("the question block tells the owner exactly how to answer", () => {
  const b = questionBlock(Q);
  assert.match(b, /Should the florist reminder go out in the morning or the evening\?/);
  assert.match(b, /\*\*A\*\* In the morning, at 9:00/);
  assert.match(b, /\*\*C\*\* Do not send a reminder/);
  assert.match(b, /answer: B/);
});

test("an answer is a line 'answer: <letter>' with an optional note, and only a listed letter counts", () => {
  assert.deepEqual(parseAnswer("answer: B", Q.choices), { letter: "B", note: null });
  assert.deepEqual(parseAnswer("Thanks.\r\nAnswer: c, but only on weekdays\n", Q.choices), { letter: "C", note: "but only on weekdays" });
  assert.deepEqual(parseAnswer("ANSWER - a", Q.choices), { letter: "A", note: null });
  assert.equal(parseAnswer("answer: D", Q.choices), null, "D is not a choice");
  assert.equal(parseAnswer("I think B is better", Q.choices), null, "no answer line");
  assert.equal(parseAnswer("the answer: B is wrong", Q.choices), null, "must start the line");
  assert.equal(parseAnswer("answer: Because", Q.choices), null, "a word is not a letter");
});

const asked = { ...Q, asked_at: "2026-10-27T10:00:00Z" };
const comment = (body, at, extra = {}) => ({
  body, created_at: at, html_url: `https://github.com/o/r/pull/9#c-${at}`,
  user: { login: "Javoo-bot", type: "User" }, author_association: "OWNER", ...extra,
});

test("the answer is the first comment by a person after the question was asked", () => {
  const comments = [
    comment("answer: A", "2026-10-27T09:00:00Z"),
    comment("answer: C", "2026-10-27T11:00:00Z", { user: { login: "github-actions[bot]", type: "Bot" } }),
    comment("answer: B", "2026-10-27T11:30:00Z", { author_association: "NONE", user: { login: "stranger", type: "User" } }),
    comment("Looks fine", "2026-10-27T11:45:00Z"),
    comment("answer: B, keep it short", "2026-10-27T12:00:00Z"),
    comment("answer: C", "2026-10-27T13:00:00Z"),
  ];
  assert.deepEqual(findAnswer(comments, asked), {
    letter: "B", choice: "In the evening, at 18:00", note: "keep it short", by: "Javoo-bot",
    at: "2026-10-27T12:00:00Z", url: "https://github.com/o/r/pull/9#c-2026-10-27T12:00:00Z",
  });
  assert.equal(findAnswer(comments.slice(0, 4), asked), null);
  assert.equal(findAnswer([], asked), null);
});

test("the place to read answers comes from the PR or issue link", () => {
  assert.deepEqual(issueRef("https://github.com/Javoo-bot/facundo/pull/41"), { repo: "Javoo-bot/facundo", number: 41 });
  assert.deepEqual(issueRef("https://github.com/Javoo-bot/facundo/issues/7"), { repo: "Javoo-bot/facundo", number: 7 });
  assert.equal(issueRef("https://example.com/x"), null);
  assert.equal(issueRef(null), null);
});

test("an answer reopens the card and keeps the question", () => {
  const card = { id: "c1", status: WAITING, question: { ...asked, round: 1, pr_url: "https://github.com/o/r/pull/9" } };
  const answer = findAnswer([comment("answer: B", "2026-10-27T12:00:00Z")], asked);
  const p = resumePatch(card, answer, "2026-10-27T12:05:00Z");
  assert.equal(p.status, "open");
  assert.deepEqual(p.answer, { ...answer, round: 1 });
  assert.equal(p.updated_at, "2026-10-27T12:05:00Z");
  assert.equal("question" in p, false, "the question stays on the card for the next brief");
});

test("a question with no code yet becomes an issue: the question first, then which card asked", () => {
  const card = { id: "55fc7df0-b969", agent: "hawkeye", source: "photo_review", title: "Hawkeye: The photo check could not decide", summary: "11 checks ended this way." };
  const { title, body } = questionIssue({ card, question: Q, run: { id: "run1" }, runUrl: "https://github.com/o/r/actions/runs/42" });
  assert.equal(title, "Question: The photo check could not decide");
  assert.ok(body.startsWith("**A question for the owner"));
  assert.match(body, /11 checks ended this way\./);
  assert.match(body, /Factory card `55fc7df0-b969` \(hawkeye, photo_review\), run `run1`/);
  assert.match(body, /\[Actions run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/42\)/);
});

test("the next brief carries the question and the owner's pick, and nothing when unanswered", () => {
  const card = { question: { ...asked, round: 1 }, answer: { letter: "B", choice: "In the evening, at 18:00", note: "keep it short", by: "Javoo-bot", at: "2026-10-27T12:00:00Z", round: 1 } };
  const b = answerBrief(card);
  assert.match(b, /## The owner answered your question/);
  assert.match(b, /Should the florist reminder go out/);
  assert.match(b, /He chose B: In the evening, at 18:00/);
  assert.match(b, /keep it short/);
  assert.equal(answerBrief({ question: asked }), "");
  assert.equal(answerBrief({}), "");
  // An answer to an older round does not answer a newer question.
  assert.equal(answerBrief({ question: { ...asked, round: 2 }, answer: { ...card.answer, round: 1 } }), "");
});

// ---- On the managers' base: card life, the to_jessica step, the migration -------

test("a waiting card never closes as quiet, but its rule's alerts keep its evidence fresh", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const ago = (days) => new Date(now - days * DAY_MS).toISOString();
  const waiting = { id: "card-1", general_rule: "order-on-map", status: WAITING, merged_at: ago(30), last_seen_at: ago(30), runs: [{ finished_at: ago(30) }] };
  assert.deepEqual(quietCards([waiting], now), [], "waiting on the owner is not quiet");
  const alert = { alert_id: "a1", source: "stuck_order", key: "k", rule_id: "order-on-map", match: "exact", placed_at: ago(1), last_seen_at: ago(0.1) };
  assert.deepEqual(ruleCardPlan({ alerts: [alert], cards: [waiting], now }).map((p) => [p.action, p.id]), [["refresh", "card-1"]]);
});

test("Mike's question skips the manager's check and goes to Jessica with the question", () => {
  const question = { text: Q.text, choices: Q.choices };
  const d = { outcome: "question", cardStatus: WAITING, openPr: true, merge: false, question, notes: `Asked the owner: ${Q.text}` };
  const m = { manager: "donna", brief: { version: 1, text: "## Fixed means\n..." }, sendBacks: 0, verdict: null };
  const { decision, events } = applyCheck(d, m);
  assert.equal(decision, d, "the decision stays: the card waits, no send-back, no needs-human");
  assert.deepEqual(events.map((e) => e.type), ["to_jessica"]);
  assert.match(events[0].data.why, /^Mike asked: Should the florist reminder/);
  assert.equal(events[0].data.question, question);
  assert.equal(checkLine(m, d), "", "the question block leads the PR, not a check line");
});

test("the migration lets a card wait for an answer, keeps it live, and lets a run end on a question", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../supabase/migrations");
  const sql = readFileSync(join(dir, "20261027130000_factory_questions.sql"), "utf8");
  assert.match(sql.match(/factory_tasks_status_check\s+check \(status in \(([^)]*)\)\)/)[1], /'waiting_for_answer'/);
  assert.match(sql.match(/factory_runs_outcome_check\s+check \(outcome in \(([^)]*)\)\)/)[1], /'question'/);
  assert.match(sql, /on factory_tasks \(fingerprint\) where status in \('open', 'in-progress', 'waiting_for_answer'\)/);
  assert.match(sql, /add column if not exists question jsonb/);
  assert.match(sql, /add column if not exists answer jsonb/);
  // One new file, no table defined twice: this migration creates no table.
  assert.doesNotMatch(sql, /create table/i);
});
