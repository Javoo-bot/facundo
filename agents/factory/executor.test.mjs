// node --test agents/factory/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WAITING } from "./questions.mjs";
import { ARENA_MODEL, DEFAULT_MODEL, PROTECTED_PATHS, modelFor, riskyArea, FREE_PATHS, LEARNED_CAP, appendLearned, cardIdRange, learnedLine, titleAgent, mergedCardPr, verifyMapPrompt, freeLane, actionsRunUrl, briefPath, agentUsage, branchFor, buildPrompt, decide, evidenceLine, moveGoodTag, parkIfSpent, parseReport, pickCard, prBody, staleRuns, timedOutExit, PR_LINE_LIMIT, changeGraph, changedLines, diffAnchor, parseNumstat, splitPoint, COOL_OFF_MS, DOCTOR_TRIES, MAX_TRIES, STALE_RUN_MS } from "./executor.mjs";

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

test("Jessica's money cards wait for a person; a reopened card counts only its runs since reopening", () => {
  assert.equal(pickCard([{ ...card("money", "2026-10-01T00:00:00Z"), manager: "jessica" }], NOW), null);
  const old = Array.from({ length: MAX_TRIES }, (_, i) => finished(COOL_OFF_MS * (i + 3)));
  const reopened = { ...card("back", "2026-10-01T00:00:00Z", old), manager: "donna", reopened_at: ago(COOL_OFF_MS * 2) };
  assert.equal(pickCard([reopened], NOW).id, "back");
  assert.equal(pickCard([{ ...reopened, reopened_at: null }], NOW), null);
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

test("on a runner with its own garden the brief says where it runs, how to sign in, and to prove UI with verify", () => {
  const c = card("55fc7df0-b969", "2026-10-12T00:00:00Z");
  const withGarden = buildPrompt({ card: c, agentFile: "x", base: "garden", branch: branchFor(c), localGarden: true });
  assert.match(withGarden, /http:\/\/localhost:3001/);
  assert.match(withGarden, /factory-staff@example\.com/);
  assert.match(withGarden, /\.claude\/skills\/verify/);
  assert.doesNotMatch(withGarden, /You have no database/);
  const boxed = buildPrompt({ card: c, agentFile: "x", base: "garden", branch: branchFor(c) });
  assert.doesNotMatch(boxed, /localhost:3001/);
  assert.match(boxed, /You have no database/);
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

test("PR body: evidence line first, then the plain summary or the protected-path warning", () => {
  const c = card("55fc7df0-b969", "2026-10-12T00:00:00Z");
  const report = "OUTCOME: fixed\n\nThe photo check now holds the money.";
  const runUrl = "https://github.com/o/r/actions/runs/42";
  const evidence = ["2026-shot-orders/recording.webm", "2026-shot-orders/01-orders.png", "2026-shot-orders/02-after.png", "2026-shot-orders/run.log"];
  const plain = prBody({ card: c, report, decision: decide({ report, commits: 1, files: ["a.ts"] }), run: { id: "run1" }, runUrl, evidence });
  const [first, , second] = plain.split("\n");
  assert.equal(first, "**Evidence:** 1 video, 2 screenshots in the [Actions run](https://github.com/o/r/actions/runs/42) (artifact `factory-out`, folder `evidence/`). **Gate:** passed, outcome `fixed`.");
  assert.equal(second, "The photo check now holds the money.");
  assert.match(plain, /never merges/);
  const guarded = prBody({ card: c, report, decision: decide({ report, commits: 1, files: ["dashboard/lib/airwallex/card.ts"] }), run: { id: "run1" }, runUrl });
  const [gFirst, , gSecond] = guarded.split("\n");
  assert.match(gFirst, /^\*\*Evidence:\*\* no video or screenshots \(tests only\) in the \[Actions run\]/);
  assert.match(gFirst, /\*\*Gate:\*\* needs a person \(protected paths\), outcome `needs-human`\.$/);
  assert.ok(gSecond.startsWith("**Needs a person"));
});

test("the evidence line points at the local out folder off GitHub", () => {
  const line = evidenceLine({ runUrl: null, evidence: ["x/recording.webm"], decision: { outcome: "fixed", guarded: [] } });
  assert.equal(line, "**Evidence:** 1 video, 0 screenshots in the run's `out/evidence/` folder. **Gate:** passed, outcome `fixed`.");
});

test("the Actions run link comes from the GitHub env, and is null off GitHub", () => {
  assert.equal(actionsRunUrl({ GITHUB_SERVER_URL: "https://github.com", GITHUB_REPOSITORY: "Javoo-bot/facundo", GITHUB_RUN_ID: "123" }), "https://github.com/Javoo-bot/facundo/actions/runs/123");
  assert.equal(actionsRunUrl({}), null);
});

test("a run that commits a video never opens a PR (videos never go into git)", () => {
  const d = decide({ report: "OUTCOME: fixed\n\nDone.", commits: 1, files: ["a.ts", "docs/agent-factory/tasks/card-1/proof.webm"] });
  assert.deepEqual([d.outcome, d.cardStatus, d.openPr], ["failed", "open", false]);
  assert.match(d.notes, /proof\.webm/);
  assert.equal(decide({ report: "OUTCOME: fixed\n\nDone.", commits: 1, files: ["a.ts", "shot.png"] }).openPr, true);
});

// ---- Doctor lane ------------------------------------------------------------------
const doctorCard = (id, created, runs = [], status = "open") => ({ ...card(id, created, runs, status), agent: "factory", source: "factory", fingerprint: "factory:factory:time-cap" });

test("the doctor works only factory cards, and the normal executor never does", () => {
  const cards = [doctorCard("doc", "2026-10-01T00:00:00Z"), card("normal", "2026-10-02T00:00:00Z")];
  assert.equal(pickCard(cards, NOW).id, "normal");
  assert.equal(pickCard(cards, NOW, { lane: "doctor" }).id, "doc");
  assert.equal(pickCard([card("normal", "2026-10-02T00:00:00Z")], NOW, { lane: "doctor" }), null);
  assert.equal(pickCard([doctorCard("doc", "2026-10-01T00:00:00Z")], NOW), null);
});

test("a factory card gets at most 2 doctor tries, then it is parked with a note", () => {
  const spent = doctorCard("spent", "2026-10-01T00:00:00Z", Array.from({ length: DOCTOR_TRIES }, (_, i) => finished(COOL_OFF_MS * (i + 2))));
  assert.equal(pickCard([spent], NOW, { lane: "doctor" }), null);
  const gaveUp = decide({ report: "OUTCOME: gave-up\n\nNot a code problem.", commits: 0 });
  assert.equal(parkIfSpent(gaveUp, 1).cardStatus, "open", "first try: back to open");
  const parked = parkIfSpent(gaveUp, DOCTOR_TRIES);
  assert.equal(parked.cardStatus, "parked");
  assert.match(parked.notes, /Parked after 2 doctor tries/);
  const pr = decide({ report: "OUTCOME: fixed\n\nx", commits: 1, files: ["agents/factory/executor.mjs"], doctor: true });
  assert.equal(parkIfSpent(pr, DOCTOR_TRIES).cardStatus, "in-progress", "a card with a PR waits for its review");
});

test("a doctor PR is always needs-human and says so first", () => {
  const report = "OUTCOME: fixed\n\nThe executor now retries.";
  const d = decide({ report, commits: 1, files: ["agents/factory/executor.mjs"], doctor: true });
  assert.deepEqual([d.outcome, d.cardStatus, d.openPr], ["needs-human", "in-progress", true]);
  const body = prBody({ card: doctorCard("55fc7df0-b969", "2026-10-12T00:00:00Z"), report, decision: d, run: { id: "r" } });
  const [first, , second] = body.split("\n");
  assert.match(first, /\*\*Gate:\*\* needs a person \(doctor PR\), outcome `needs-human`\.$/);
  assert.ok(second.startsWith("**Needs a person"));
});

test("factory-good moves only after a clean run of the garden executor", () => {
  assert.equal(moveGoodTag({ executorRef: "garden", outcome: "fixed", commits: 1 }), true);
  assert.equal(moveGoodTag({ executorRef: "garden", outcome: "gave-up", commits: 0 }), true, "no change, no failure");
  assert.equal(moveGoodTag({ executorRef: "garden", outcome: "needs-human", commits: 0 }), true);
  assert.equal(moveGoodTag({ executorRef: "garden", outcome: "failed", commits: 0 }), false);
  assert.equal(moveGoodTag({ executorRef: "garden", outcome: "needs-human", commits: 2 }), false, "a guarded PR is not proof the executor is fine");
  assert.equal(moveGoodTag({ executorRef: "factory/cloud-agents", outcome: "fixed", commits: 1 }), false);
  assert.equal(moveGoodTag({ executorRef: "factory-good", outcome: "fixed", commits: 1 }), false);
});

test("a doctor brief carries the doctor file instead of a thinking agent", () => {
  const c = doctorCard("55fc7df0-b969", "2026-10-12T00:00:00Z");
  const p = buildPrompt({ card: c, agentFile: "Fix the factory.", agentPath: "agents/factory/doctor.md", base: "garden", branch: branchFor(c) });
  assert.match(p, /## The agent you are improving: agents\/factory\/doctor\.md/);
  assert.doesNotMatch(p, /agents\/thinking\/factory\.md/);
});

// ---- Free lane --------------------------------------------------------------------
const shots = ["2026-shot-email/recording.webm", "2026-shot-email/01-email.png"];
const fixedReport = "OUTCOME: fixed\n\nThe florist email now says thank you.";

test("a wording-only fixed run with evidence opens a ready PR that merges; the card waits for 7 quiet days", () => {
  const d = decide({ report: fixedReport, commits: 1, files: ["dashboard/lib/i18n/messages/en.ts", "dashboard/lib/i18n/messages/es.ts"], evidence: shots, automerge: true });
  assert.deepEqual([d.outcome, d.cardStatus, d.openPr, d.merge], ["fixed", "in-progress", true, true]);
  const body = prBody({ card: card("55fc7df0-b969", "2026-10-12T00:00:00Z"), report: fixedReport, decision: d, run: { id: "r" }, evidence: shots });
  assert.match(body.split("\n")[0], /\*\*Gate:\*\* passed, free lane \(merges itself\), outcome `fixed`\.$/);
  assert.match(body, /the factory merges it into garden/);
  assert.equal(decide({ report: fixedReport, commits: 1, files: ["dashboard/app/design-system.css", "dashboard/components/BrandLogo.tsx"], evidence: shots, automerge: true }).merge, true, "look only");
});

test("anything else stays a draft for a person: payouts, mixed files, no evidence, not fixed, switch off, doctor", () => {
  const wording = ["dashboard/lib/i18n/messages/en.ts"];
  const rows = [
    [{ files: ["dashboard/lib/payoutMath.ts"] }, "needs-human"],
    [{ files: [...wording, "dashboard/lib/payoutMath.ts"] }, "needs-human"],
    [{ files: [...wording, "dashboard/lib/orderTags.ts"] }, "fixed"],
    [{ files: ["dashboard/lib/i18n/index.ts"] }, "fixed"],
    [{ evidence: ["2026-shot/run.log"] }, "fixed"],
    [{ evidence: [] }, "fixed"],
    [{ automerge: false }, "fixed"],
    [{ report: "OUTCOME: needs-human\n\nNot sure about the tone." }, "needs-human"],
    [{ doctor: true }, "needs-human"],
  ];
  for (const [over, outcome] of rows) {
    const d = decide({ report: fixedReport, commits: 1, files: wording, evidence: shots, automerge: true, ...over });
    assert.deepEqual([d.outcome, d.cardStatus, d.openPr, !!d.merge], [outcome, "in-progress", true, false], JSON.stringify(over));
  }
  assert.equal(freeLane([]), false, "no files is not the free lane");
  assert.ok(FREE_PATHS.every((p) => !p.startsWith("dashboard/lib/payout")));
});

test("an error card's brief is errors.md, a factory card's doctor.md, any other its agent's file", () => {
  assert.equal(briefPath({ source: "error", agent: "factory" }), "agents/factory/errors.md");
  assert.equal(briefPath({ source: "factory", agent: "factory" }), "agents/factory/doctor.md");
  assert.equal(briefPath({ source: "photo_review", agent: "hawkeye" }), "agents/thinking/hawkeye.md");
  // an error card is the normal lane's, never the doctor's
  const err = { ...card("e", "2026-10-12T00:00:00Z"), source: "error", agent: "factory" };
  assert.equal(pickCard([err], NOW).id, "e");
  assert.equal(pickCard([err], NOW, { lane: "doctor" }), null);
});

test("after-merge finds only the card PR this garden commit merged", () => {
  const pr = (number, ref, merged_sha) => ({ number, head: { ref }, merged_at: merged_sha ? "2026-10-14T14:44:34Z" : null, merge_commit_sha: merged_sha ?? `test-${number}` });
  // The real shape for 973000d3: the merged PR plus open PRs that contain the commit.
  const pulls = [pr(7, "factory/card-b4f1f1b3", "973000d3"), pr(9, "factory/card-951166d1"), pr(10, "factory/card-bf56c830")];
  assert.equal(mergedCardPr(pulls, "973000d3").number, 7);
  // A direct push to garden, contained in an older merged card PR: not ours.
  assert.equal(mergedCardPr(pulls, "c5915f09"), null);
  // A merged PR from any other branch (a verify-map PR, a person's branch).
  assert.equal(mergedCardPr([pr(20, "factory/verify-map-7", "aa11")], "aa11"), null);
  assert.equal(mergedCardPr([pr(21, "owner/fix", "bb22")], "bb22"), null);
});

test("the verify-map brief names the PR, its files, the skill and the edit scope", () => {
  const p = verifyMapPrompt({ pr: { number: 7, title: "reply subjects" }, files: ["dashboard/lib/replySubject.ts"] });
  for (const s of ["#7", "- dashboard/lib/replySubject.ts", "pstack:maintain-verification-skill", "only files under .claude/skills/verify/", "nothing to update"]) assert.ok(p.includes(s), s);
});

test("owner memory: one dated fact per merged PR under ## Learned, newest 20 kept", () => {
  const pr = { number: 7, title: 'factory(cupid): reply subjects come out as "Re: Re: …"', merged_at: "2026-10-14T14:44:34Z" };
  const line = learnedLine(pr);
  assert.equal(line, '- 2026-10-14: reply subjects come out as "Re: Re: …" (PR #7)');
  const file = "---\nid: cupid\n---\n\n## Job\n\nWrites replies.\n";
  const once = appendLearned(file, line);
  assert.equal(once, `${file}\n## Learned\n\n${line}\n`);
  // A rerun does not repeat the fact; other sections after it stay put.
  assert.equal(appendLearned(once, line), once);
  const mid = appendLearned("## Learned\n\n- old\n\n## Rules\n\n- keep\n", line);
  assert.equal(mid, `## Learned\n\n- old\n${line}\n\n## Rules\n\n- keep\n`);
  // Cap: 25 facts in, the newest 20 out, the new one last.
  let text = file;
  for (let i = 1; i <= 25; i++) text = appendLearned(text, `- 2026-10-${String(i).padStart(2, "0")}: fact ${i} (PR #${i})`);
  const facts = text.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(facts.length, LEARNED_CAP);
  assert.equal(facts[0], "- 2026-10-06: fact 6 (PR #6)");
  assert.equal(facts.at(-1), "- 2026-10-25: fact 25 (PR #25)");
});

test("owner memory finds the card from its branch, or the agent from the title", () => {
  assert.deepEqual(cardIdRange("factory/card-b4f1f1b3"), ["b4f1f1b3-0000-0000-0000-000000000000", "b4f1f1b3-ffff-ffff-ffff-ffffffffffff"]);
  assert.equal(cardIdRange("factory/verify-map-7"), null);
  assert.equal(titleAgent("factory(cupid): reply subjects"), "cupid");
  assert.equal(titleAgent("Recruiting replies: signed address"), null);
});

test("risky cards (payouts, login, senders, migrations) plan with arena on the stronger model; the rest stay on Haiku", () => {
  const c = (title, summary = "", agent = "hawkeye") => ({ ...card("a1b2c3d4-0000", "2026-10-12T00:00:00Z"), title, summary, agent });
  const risky = [
    [c("Payouts: the 30% leg was held twice"), "payouts"],
    [c("Florist card", "Airwallex refused the card for this shop"), "payouts"],
    [c("Staff cannot log in after the reset"), "login"],
    [c("Sign-in loops", "OAuth callback bounces an allowed email"), "login"],
    [c("Offers go out twice", "the SMS sender retries a sent message"), "senders"],
    [c("Orders table", "a migration dropped the index"), "migrations"],
    [c("Anything", "", "payouts")],
  ];
  for (const [k, area] of risky) {
    assert.equal(riskyArea(k), area ?? "payouts", k.title);
    assert.equal(modelFor(k), ARENA_MODEL, k.title);
    assert.match(buildPrompt({ card: k, agentFile: "x", base: "garden", branch: branchFor(k) }), /plan\s+with the pstack:arena skill/, k.title);
  }
  // Every protected area outside the factory's own folders counts as risky.
  for (const p of PROTECTED_PATHS.filter((p) => !p.startsWith("."))) assert.ok(riskyArea(c(`Bug in ${p}`)), p);

  const safe = [
    c("Hawkeye: The photo check could not decide"),
    c("The order email subject reads wrong", "the wording of the confirmation email is stiff"),
    c("Logo spacing", "the author of the theme asked for more space"),
  ];
  for (const k of safe) {
    assert.equal(riskyArea(k), null, k.title);
    assert.equal(modelFor(k), DEFAULT_MODEL, k.title);
    assert.equal(modelFor(k, "sonnet"), "sonnet", "the env override still wins for ordinary cards");
    assert.doesNotMatch(buildPrompt({ card: k, agentFile: "x", base: "garden", branch: branchFor(k) }), /arena/, k.title);
  }
  assert.equal(DEFAULT_MODEL, "claude-haiku-5-5");
  assert.equal(ARENA_MODEL, "claude-sonnet-5-5");
});

test("PR review graph: one box per file by folder, coloured by risk, each linking to its diff", () => {
  const stats = parseNumstat("12\t3\tdashboard/lib/i18n/messages/en.ts\n40\t0\tdashboard/lib/payoutMath.ts\n-\t-\tdocs/x.png\n");
  assert.deepEqual(stats.map((s) => [s.file, s.added, s.deleted]), [
    ["dashboard/lib/i18n/messages/en.ts", 12, 3], ["dashboard/lib/payoutMath.ts", 40, 0], ["docs/x.png", 0, 0],
  ]);
  assert.equal(changedLines(stats), 55);
  const g = changeGraph(stats, (f) => `https://pr/files#${f}`);
  assert.match(g, /^\*\*3 files, \+52 −3 \(55 lines\)\.\*\*/);
  assert.match(g, /```mermaid\nflowchart LR/);
  assert.match(g, /subgraph g\d\["dashboard\/lib"\]/);
  assert.match(g, /f0\["en\.ts<br\/>\+12 −3"\]:::free/);
  assert.match(g, /f1\["payoutMath\.ts<br\/>\+40 −0"\]:::risky/);
  assert.match(g, /f2\["x\.png<br\/>\+0 −0"\]:::code/);
  assert.match(g, /click f1 "https:\/\/pr\/files#dashboard\/lib\/payoutMath\.ts" _blank/);
  assert.equal(diffAnchor("https://gh/pr/9", "a.ts", (s) => `h(${s})`), "https://gh/pr/9/files#diff-h(a.ts)");
  // The agent's prose folds away under the graph.
  const body = prBody({ card: { id: "abc", agent: "cupid", source: "x" }, report: "OUTCOME: fixed\nLong notes.", decision: { outcome: "fixed" }, run: { id: "r" }, graph: g });
  assert.match(body, /```mermaid[\s\S]*<details><summary>The agent's notes<\/summary>\n\nLong notes\./);
});

test("over 1,000 changed lines splits at a commit boundary into two PRs; one big commit cannot split", () => {
  assert.equal(PR_LINE_LIMIT, 1000);
  assert.equal(splitPoint([400, 500]), null, "900 lines fits one PR");
  assert.equal(splitPoint([600, 400]), null, "exactly the limit fits in one PR");
  assert.equal(splitPoint([600, 300, 500]), 2, "first PR takes commits while they fit");
  assert.equal(splitPoint([1200, 50]), null, "first commit alone is over the limit");
  assert.equal(splitPoint([1500]), null, "one commit cannot split");
  assert.equal(splitPoint([700, 700]), 1);
  assert.match(buildPrompt({ card: card("a", ago(1)), agentFile: "x", base: "garden", branch: "b" }), /under 1000 lines[\s\S]*two PRs/);
});

// ---- Ask when unsure: the question/answer flow (questions.mjs) -----------------

const asking = `OUTCOME: question

Two reminder times both look right; I need the owner to pick.

## Question

Should the florist reminder go out in the morning or the evening?

A) In the morning, at 9:00
B) In the evening, at 18:00

## Appendix

None.`;

test("an unsure run stores its question and the card waits for the owner, PR or not", () => {
  assert.equal(parseReport(asking).outcome, "question");
  const withCode = decide({ report: asking, commits: 1, files: ["dashboard/lib/reminders.ts"] });
  assert.deepEqual([withCode.outcome, withCode.cardStatus, withCode.openPr, withCode.askIssue], ["question", WAITING, true, false]);
  assert.equal(withCode.question.choices.length, 2);
  assert.match(withCode.notes, /^Asked the owner: Should the florist reminder/);
  const noCode = decide({ report: asking, commits: 0 });
  assert.deepEqual([noCode.outcome, noCode.cardStatus, noCode.openPr, noCode.askIssue], ["question", WAITING, false, true]);
  // A protected path still says "Needs a person" while it waits.
  const guarded = decide({ report: asking, commits: 1, files: ["supabase/migrations/x.sql"] });
  assert.deepEqual([guarded.cardStatus, guarded.guarded], [WAITING, ["supabase/migrations/x.sql"]]);
  // A question the factory cannot put to the owner falls back to today's needs-human.
  const garbled = decide({ report: "OUTCOME: question\n\nNot sure what to do.", commits: 1, files: ["a.ts"] });
  assert.deepEqual([garbled.outcome, garbled.cardStatus, garbled.question], ["needs-human", "in-progress", undefined]);
  assert.match(garbled.notes, /could not be read/);
  // A time cap still wins.
  assert.equal(decide({ report: asking, commits: 1, timedOut: true }).outcome, "failed");
});

test("the executor skips a waiting card, and an answer skips the day's cool-off", () => {
  const waiting = { ...card("w", "2026-10-01T00:00:00Z", [finished(COOL_OFF_MS * 3)]), status: WAITING };
  assert.equal(pickCard([waiting], NOW), null);
  const tried = [finished(60 * 60_000)];
  const unanswered = card("u", "2026-10-02T00:00:00Z", tried);
  assert.equal(pickCard([unanswered], NOW), null, "tried an hour ago, no answer: cools off");
  const answered = { ...card("a", "2026-10-03T00:00:00Z", tried), question: { round: 1 }, answer: { round: 1, at: ago(30 * 60_000) } };
  assert.equal(pickCard([unanswered, answered], NOW).id, "a");
  const stale = { ...answered, answer: { round: 1, at: ago(2 * 60 * 60_000) } };
  assert.equal(pickCard([stale], NOW), null, "an answer older than the last try does not skip the cool-off");
});

test("a resumed card works on its own branch, so the question's draft PR is not overwritten", () => {
  const c = card("55fc7df0-b969", "2026-10-12T00:00:00Z");
  assert.equal(branchFor(c), "factory/card-55fc7df0");
  assert.equal(branchFor({ ...c, answer: { round: 1 } }), "factory/card-55fc7df0-a1");
  assert.deepEqual(cardIdRange("factory/card-55fc7df0-a1"), cardIdRange("factory/card-55fc7df0"));
  const pull = { number: 30, merged_at: "2026-10-28T10:00:00Z", merge_commit_sha: "cc33", head: { ref: "factory/card-55fc7df0-a2" } };
  assert.equal(mergedCardPr([pull], "cc33").number, 30);
});

test("the brief says how to ask, and carries the owner's answer when there is one", () => {
  const c = card("55fc7df0-b969", "2026-10-12T00:00:00Z");
  const fresh = buildPrompt({ card: c, agentFile: "x", base: "garden", branch: branchFor(c) });
  assert.match(fresh, /OUTCOME: question/);
  assert.match(fresh, /## Question/);
  assert.doesNotMatch(fresh, /The owner answered/);
  const q = { text: "Morning or evening?", choices: [{ letter: "A", text: "Morning" }, { letter: "B", text: "Evening" }], round: 1 };
  const answered = { ...c, question: q, answer: { letter: "B", choice: "Evening", note: null, round: 1 } };
  const resumed = buildPrompt({ card: answered, agentFile: "x", base: "garden", branch: branchFor(answered) });
  assert.match(resumed, /## The owner answered your question[\s\S]*He chose B: Evening\./);
  assert.ok(resumed.indexOf("The owner answered") < resumed.indexOf("## Rules"), "the answer comes before the rules");
});

test("a question PR leads with the question and its gate says it waits for the owner", () => {
  const c = card("55fc7df0-b969", "2026-10-12T00:00:00Z");
  const d = decide({ report: asking, commits: 1, files: ["dashboard/lib/reminders.ts"] });
  const body = prBody({ card: c, report: asking, decision: d, run: { id: "run1" } });
  const lines = body.split("\n");
  assert.match(lines[0], /\*\*Gate:\*\* waiting for the owner's answer, outcome `question`\.$/);
  assert.match(lines[2], /^\*\*A question for the owner/);
  assert.match(body, /answer: B/);
  // With protected paths the "Needs a person" line still comes first.
  const g = decide({ report: asking, commits: 1, files: ["supabase/migrations/x.sql"] });
  const gl = prBody({ card: c, report: asking, decision: g, run: { id: "run1" } }).split("\n");
  assert.ok(gl[2].startsWith("**Needs a person"));
  assert.match(gl[4], /^\*\*A question for the owner/);
});
