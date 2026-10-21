// node --test agents/factory/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { agentUsage, branchFor, buildPrompt, decide, parseReport, pickCard, prBody, staleRuns, timedOutExit, COOL_OFF_MS, MAX_TRIES, STALE_RUN_MS } from "./executor.mjs";

const NOW = Date.parse("2026-10-14T09:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const card = (id, created, runs = [], status = "open") => ({
  id, status, runs, created_at: created, agent: "hawkeye", title: "Hawkeye: The photo check could not decide",
  summary: "11 delivery photo checks ended this way.", source: "photo_review", fingerprint: "hawkeye:photo_review:review",
  latest_signal_at: "2026-10-13T17:53:23Z", evidence: { count: 11, examples: [{ order_id: "ab869dd4" }] },
});
const finished = (startedAgo) => ({ id: `r${startedAgo}`, started_at: ago(startedAgo), finished_at: ago(startedAgo - 1000) });

test("picks the oldest open card", () => {
  const cards = [card("b", "2026-10-13T00:00:00Z"), card("a", "2026-10-12T00:00:00Z"), card("c", "2026-10-11T00:00:00Z", [], "in-progress")];
  assert.equal(pickCard(cards, NOW).id, "a");
});

test("skips a card with a run in progress, one tried in the last day, and one out of tries", () => {
  const running = card("running", "2026-10-01T00:00:00Z", [{ id: "x", started_at: ago(60_000), finished_at: null }]);
  const cooling = card("cooling", "2026-10-02T00:00:00Z", [finished(COOL_OFF_MS - 60_000)]);
  const spent = card("spent", "2026-10-03T00:00:00Z", Array.from({ length: MAX_TRIES }, (_, i) => finished(COOL_OFF_MS * (i + 2))));
  const retry = card("retry", "2026-10-04T00:00:00Z", [finished(COOL_OFF_MS + 60_000)]);
  assert.equal(pickCard([running, cooling, spent, retry], NOW).id, "retry");
  assert.equal(pickCard([running, cooling, spent], NOW), null);
});

test("only runs unfinished past the stale limit are stale", () => {
  const cards = [card("a", "2026-10-01T00:00:00Z", [
    { id: "old", started_at: ago(STALE_RUN_MS + 1), finished_at: null },
    { id: "young", started_at: ago(STALE_RUN_MS - 60_000), finished_at: null },
    { id: "done", started_at: ago(STALE_RUN_MS * 2), finished_at: ago(STALE_RUN_MS) },
  ])];
  assert.deepEqual(staleRuns(cards, NOW), ["old"]);
});

test("the brief names one agent, carries its file and the evidence, and asks for the report", () => {
  const c = card("55fc7df0-b969", "2026-10-12T00:00:00Z");
  const p = buildPrompt({ card: c, agentFile: "---\nid: hawkeye\n---\n## Job\nDecide the photo.", base: "garden", branch: branchFor(c) });
  assert.match(p, /exactly one agent: hawkeye/);
  assert.match(p, /## Job\nDecide the photo\./);
  assert.match(p, /"order_id": "ab869dd4"/);
  assert.match(p, /factory\/card-55fc7df0/);
  assert.match(p, /\/out\/report\.md/);
  assert.match(p, /Never change alone: money/);
});

test("report outcome is read from line 1 only, and only the three words count", () => {
  assert.deepEqual(parseReport("OUTCOME: fixed\n\nPhotos now hold.\n"), { outcome: "fixed", body: "Photos now hold." });
  assert.equal(parseReport("﻿OUTCOME: Needs-Human\r\n\r\nx").outcome, "needs-human");
  assert.equal(parseReport("Summary first\nOUTCOME: fixed").outcome, null);
  assert.equal(parseReport("OUTCOME: merged\n").outcome, null);
  assert.equal(parseReport("").outcome, null);
});

test("outcome table", () => {
  const ok = "OUTCOME: fixed\n\nThe photo check now holds the money.\n\nWhat the tests show: ...";
  const rows = [
    [{ report: ok, commits: 2, files: ["dashboard/lib/photoVerify/index.ts"] }, "fixed", "in-progress", true],
    [{ report: ok, commits: 1, files: ["dashboard/lib/payoutMath.ts"] }, "needs-human", "in-progress", true],
    [{ report: ok, commits: 1, files: ["supabase/migrations/x.sql"] }, "needs-human", "in-progress", true],
    [{ report: "OUTCOME: needs-human\n\nThe fix is in payouts.", commits: 0 }, "needs-human", "in-progress", false],
    [{ report: "OUTCOME: gave-up\n\nAlready fixed in the code.", commits: 0 }, "gave-up", "open", false],
    [{ report: "OUTCOME: fixed\n\nclaimed but nothing committed", commits: 0 }, "gave-up", "open", false],
    [{ report: "", commits: 3, boxExit: 1 }, "failed", "open", false],
    [{ report: ok, commits: 2, timedOut: true }, "failed", "open", false],
  ];
  for (const [input, outcome, cardStatus, openPr] of rows) {
    const d = decide(input);
    assert.deepEqual([d.outcome, d.cardStatus, d.openPr], [outcome, cardStatus, openPr], JSON.stringify(input));
  }
  assert.equal(decide(rows[4][0]).notes, "Already fixed in the code.");
});

test("the brief names where the report goes on each runner", () => {
  const c = card("55fc7df0-b969", "2026-10-12T00:00:00Z");
  const onRunner = buildPrompt({ card: c, agentFile: "x", base: "garden", branch: branchFor(c), reportPath: "/home/runner/work/_temp/run/out/report.md" });
  assert.match(onRunner, /## Your last step: write \/home\/runner\/work\/_temp\/run\/out\/report\.md/);
  assert.doesNotMatch(onRunner, /write \/out\/report\.md/);
  assert.match(buildPrompt({ card: c, agentFile: "x", base: "garden", branch: branchFor(c) }), /write \/out\/report\.md/);
});

test("a claude exit of 124 is the time cap, and a timed-out run never opens a PR", () => {
  assert.equal(timedOutExit("124"), true);
  assert.equal(timedOutExit(0), false);
  assert.equal(timedOutExit(""), false);
  const d = decide({ report: "OUTCOME: fixed\n\nDone.", commits: 1, files: ["a.ts"], timedOut: timedOutExit("124") });
  assert.deepEqual([d.outcome, d.openPr], ["failed", false]);
});

test("cost and turns come from the last result line of the agent log", () => {
  const log = [
    JSON.stringify({ type: "system", subtype: "init" }),
    "not json",
    JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 1.234, num_turns: 41 }),
    "",
  ].join("\n");
  assert.deepEqual(agentUsage(log), { costUsd: 1.234, turns: 41, stop: "success" });
  assert.equal(agentUsage(JSON.stringify({ type: "assistant" })), null);
  assert.equal(agentUsage(""), null);
});

test("the agent's settings deny pushing, GitHub, sudo and .claude edits", () => {
  const { permissions } = JSON.parse(readFileSync(new URL("./box/agent-settings.json", import.meta.url), "utf8"));
  for (const rule of ["Bash(git push:*)", "Bash(gh:*)", "Bash(sudo:*)", "Edit(**/.claude/**)", "Write(**/.claude/**)"]) {
    assert.ok(permissions.deny.includes(rule), rule);
  }
  assert.equal(permissions.allow, undefined);
});

test("PR body starts with the plain summary, or with the protected-path warning", () => {
  const c = card("55fc7df0-b969", "2026-10-12T00:00:00Z");
  const report = "OUTCOME: fixed\n\nThe photo check now holds the money.";
  const plain = prBody({ card: c, report, decision: decide({ report, commits: 1, files: ["a.ts"] }), run: { id: "run1" } });
  assert.ok(plain.startsWith("The photo check now holds the money."));
  assert.match(plain, /never merges/);
  const guarded = prBody({ card: c, report, decision: decide({ report, commits: 1, files: ["dashboard/lib/airwallex/card.ts"] }), run: { id: "run1" } });
  assert.ok(guarded.startsWith("**Needs a person"));
});
