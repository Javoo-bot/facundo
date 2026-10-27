// node --test agents/factory/
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { CARD_LIFE, RULES } from "./general-rules.mjs";
import { decide, prBody } from "./executor.mjs";
import { JESSICA, MANAGERS, MAX_SEND_BACKS, applyCheck, briefPrompt, briefSection, caseId, checkLine, checkPrompt, eventRows, managerFor, managerState, parseBrief, parseVerdict } from "./managers.mjs";

const here = new URL(".", import.meta.url);
const card = (extra = {}) => ({
  id: "1234abcd-0000-0000-0000-000000000000", agent: "hawkeye", source: "photo_review",
  title: "Hawkeye: The photo check could not decide", summary: "11 checks ended this way.", evidence: { count: 11 }, ...extra,
});
const BRIEF = { version: 1, text: "## Fixed means\nThe photo check decides on clear photos.\n\n## Check\n- a failing test first" };
const fixedRun = (files = ["dashboard/lib/photoCheck.ts"]) =>
  decide({ report: "OUTCOME: fixed\n\nDone.", commits: 1, files, evidence: ["a.png"], automerge: true });
const managed = (verdict, extra = {}) => ({ manager: "louis", brief: BRIEF, verdict, sendBacks: 0, ...extra });

test("the 13 general rules each have exactly one owner, taken from general-rules.json, and every manager has a role file", () => {
  const owners = [...Object.values(MANAGERS).flatMap((m) => m.rules), ...JESSICA.rules];
  assert.equal(owners.length, 13);
  assert.equal(new Set(owners).size, 13);
  for (const r of RULES) assert.ok((MANAGERS[r.owner] ?? JESSICA).rules.includes(r.id), `${r.id} -> ${r.owner}`);
  for (const id of Object.keys(MANAGERS)) assert.ok(existsSync(new URL(`managers/${id}.md`, here)), `managers/${id}.md`);
});

test("every agent file is read by exactly one manager, and every name read is a real agent", () => {
  const agents = readdirSync(new URL("../thinking/", here)).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  const reads = Object.values(MANAGERS).flatMap((m) => m.reads).sort();
  assert.deepEqual(reads, agents);
});

test("a card belongs to its general rule's owner first, else to the manager that reads its agent", () => {
  assert.equal(managerFor(card()), "louis");
  assert.equal(managerFor(card({ agent: "sherlock" })), "harvey");
  assert.equal(managerFor(card({ agent: "hawkeye", evidence: { general_rule: "shopify-agrees" } })), "donna");
  assert.equal(managerFor(card({ general_rule: "pay-exactly-owed" })), "jessica");
  assert.equal(managerFor(card({ source: "error", agent: "factory" })), "donna");
  assert.equal(managerFor(card({ source: "factory", agent: "factory" })), null);
});

test("the state keeps the newest brief and counts send-backs after it; a reopen asks for a fresh version", () => {
  const ev = (seq, type, data = {}) => ({ seq, type, data });
  const events = [ev(1, "brief_written", { version: 1, brief: "old" }), ev(2, "sent_back", { reason: "a" }),
    ev(3, "brief_written", { version: 2, brief: "new" }), ev(5, "sent_back", { reason: "c" }), ev(4, "sent_back", { reason: "b" })];
  assert.deepEqual(managerState(events), { brief: { version: 2, text: "new" }, nextVersion: 3, sendBacks: 2, lastReason: "c" });
  assert.deepEqual(managerState([...events, ev(6, "reopened")]), { brief: null, nextVersion: 3, sendBacks: 0, lastReason: null });
  assert.deepEqual(managerState([]), { brief: null, nextVersion: 1, sendBacks: 0, lastReason: null });
});

test("the brief prompt carries the card, the role, the quiet-day rule and asks for the brief shape", () => {
  const p = briefPrompt({ card: card(), manager: "louis", roleFile: "ROLE TEXT", agentFile: "HAWKEYE FILE", version: 2 });
  for (const s of ["You are Louis", "ROLE TEXT", "HAWKEYE FILE", "11 checks ended", "brief 2", `${CARD_LIFE.quietDays} days`, "## Fixed means", "Do not change any file"]) assert.ok(p.includes(s), s);
});

test("a brief is read from '## Fixed means' on; anything else is no brief", () => {
  assert.equal(parseBrief(`Sure, here it is.\n\n${BRIEF.text}`), BRIEF.text);
  assert.equal(parseBrief("I could not decide."), null);
  assert.equal(parseBrief(""), null);
});

test("Mike's prompt gets the brief, says he does not mark his own work, and the reason he was sent back", () => {
  const first = briefSection({ manager: "louis", brief: BRIEF });
  assert.ok(first.includes("Louis, version 1") && first.includes(BRIEF.text) && first.includes("you do not decide whether it passes"));
  assert.ok(!first.includes("Sent back"));
  const again = briefSection({ manager: "louis", brief: BRIEF, lastReason: "no failing test" });
  assert.ok(again.includes("## Sent back last time") && again.includes("> no failing test"));
});

test("the check prompt carries the brief and Mike's report and lists the four verdicts", () => {
  const p = checkPrompt({ card: card(), manager: "louis", roleFile: "ROLE", brief: BRIEF, report: "OUTCOME: fixed\n\nDone.", commits: 2 });
  for (const s of [BRIEF.text, "OUTCOME: fixed", "2 commit(s)", "passed", "sent-back", "dropped-as-designed", "to-jessica", "VERDICT:"]) assert.ok(p.includes(s), s);
});

test("a verdict is read from its lines; an unknown verdict is unreadable", () => {
  assert.deepEqual(parseVerdict("Looked at it.\nVERDICT: sent-back\nREASON: No failing test.\nBRANCH: none"), { verdict: "sent-back", reason: "No failing test.", branch: null });
  assert.deepEqual(parseVerdict("VERDICT: `dropped-as-designed`\nREASON: The hold is required.\nBRANCH: pay-exposure"), { verdict: "dropped-as-designed", reason: "The hold is required.", branch: "pay-exposure" });
  assert.equal(parseVerdict("VERDICT: looks fine"), null);
  assert.equal(parseVerdict(""), null);
});

test("a card nobody manages keeps the executor's decision", () => {
  const d = fixedRun();
  assert.deepEqual(applyCheck(d, null), { decision: d, events: [] });
});

test("passed keeps the PR (and the free lane); a protected path also goes to Jessica", () => {
  const free = fixedRun(["dashboard/lib/i18n/messages/en.json"]);
  const ok = applyCheck(free, managed({ verdict: "passed", reason: "Does what the brief says." }));
  assert.equal(ok.decision, free);
  assert.deepEqual(ok.events.map((e) => e.type), ["check_passed"]);
  const guarded = applyCheck(fixedRun(["supabase/migrations/x.sql"]), managed({ verdict: "passed", reason: "ok" }));
  assert.deepEqual(guarded.events.map((e) => e.type), ["check_passed", "to_jessica"]);
  assert.equal(guarded.events[1].data.why, "touches protected paths: supabase/migrations/x.sql");
});

test("sent back: no PR, no merge, card open again with the reason; past the limit it goes to Jessica with its PR", () => {
  const d = fixedRun(["dashboard/lib/i18n/messages/en.json"]);
  const back = applyCheck(d, managed({ verdict: "sent-back", reason: "No failing test." }));
  assert.equal(back.decision.openPr, false);
  assert.equal(back.decision.merge, false);
  assert.equal(back.decision.cardStatus, "open");
  assert.match(back.decision.notes, /Sent back by Louis: No failing test/);
  assert.deepEqual(back.events, [{ type: "sent_back", data: { reason: "No failing test." } }]);

  const spent = applyCheck(d, managed({ verdict: "sent-back", reason: "Still no test." }, { sendBacks: MAX_SEND_BACKS }));
  assert.equal(spent.decision.openPr, true);
  assert.equal(spent.decision.merge, false);
  assert.equal(spent.decision.outcome, "needs-human");
  assert.deepEqual(spent.events.map((e) => e.type), ["sent_back", "to_jessica"]);
});

test("dropped as designed closes the card with the situation it falls under, and opens no PR", () => {
  const d = decide({ report: "OUTCOME: gave-up\n\nWorking as designed.", commits: 0 });
  const r = applyCheck(d, managed({ verdict: "dropped-as-designed", reason: "The hold is required.", branch: "pay-exposure" }));
  assert.equal(r.decision.cardStatus, "dropped");
  assert.equal(r.decision.openPr, false);
  assert.deepEqual(r.events, [{ type: "dropped_as_designed", data: { branch: "pay-exposure", reason: "The hold is required." } }]);
});

test("to-jessica, or a check that never finished, keeps the PR as a draft that needs a person", () => {
  for (const verdict of [{ verdict: "to-jessica", reason: "Writes to Shopify." }, null]) {
    const r = applyCheck(fixedRun(["dashboard/lib/i18n/messages/en.json"]), managed(verdict));
    assert.equal(r.decision.openPr, true);
    assert.equal(r.decision.merge, false);
    assert.equal(r.decision.outcome, "needs-human");
    assert.equal(r.events.at(-1).type, "to_jessica");
    assert.match(checkLine(managed(verdict), r.decision), /^\*\*Needs a person:\*\* Louis sent it to Jessica/);
  }
});

test("the PR body carries the manager's check line right under the evidence line", () => {
  const d = fixedRun();
  const m = managed({ verdict: "passed", reason: "Does what the brief says." });
  const body = prBody({ card: card(), report: "OUTCOME: fixed\n\nDone.", decision: d, run: { id: "r1" }, check: checkLine(m, d) });
  assert.equal(body.split("\n")[2], "**Check:** Louis passed it against brief v1: Does what the brief says.");
});

test("no brief means Mike never ran: no PR; a failed run has nothing to check", () => {
  const d = fixedRun();
  const none = applyCheck(d, managed(null, { brief: null }));
  assert.equal(none.decision.openPr, false);
  assert.match(none.decision.notes, /Louis wrote no brief/);
  const failed = decide({ report: "", commits: 0, timedOut: true });
  assert.deepEqual(applyCheck(failed, managed({ verdict: "passed", reason: "x" })), { decision: failed, events: [] });
});

test("events become agent_events rows on the card's case, numbered after the last one", () => {
  const rows = eventRows(card(), 4, [{ type: "brief_written", data: { version: 1 }, at: "2026-10-27T10:00:00Z" }, { type: "sent_to_mike", data: {} }], { manager: "louis", runId: "r1", now: "2026-10-27T11:00:00Z" });
  assert.deepEqual(rows, [
    { case_id: caseId(card()), seq: 5, type: "brief_written", data: { manager: "louis", run_id: "r1", version: 1 }, created_at: "2026-10-27T10:00:00Z" },
    { case_id: "card:1234abcd-0000-0000-0000-000000000000", seq: 6, type: "sent_to_mike", data: { manager: "louis", run_id: "r1" }, created_at: "2026-10-27T11:00:00Z" },
  ]);
});
