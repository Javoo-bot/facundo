// Growing verify map (.github/workflows/factory-after-merge.yml). After a
// factory card PR merges into garden, a cheap agent checks whether
// .claude/skills/verify/ needs a new or corrected feature entry, and any
// change goes up as a draft PR labelled verify-map for the owner. The same PR adds
// one dated fact (the PR title) under "## Learned" in the card agent's
// agents/thinking/<agent>.md (owner memory). The card's merged_at is set, so its
// 7 quiet days start (general-rules.mjs).
//
//   node agents/factory/after-merge.mjs find     SHA -> the card PR it merged, brief at $BRIEF, fact at $LEARNED
//   node agents/factory/after-merge.mjs publish  VERIFY_DIR changes + the fact, in $WORK -> draft PR
//
// Needs GH_TOKEN and GITHUB_REPOSITORY; GARDEN_SUPABASE_URL + SUPABASE_API_KEY
// (garden) to read the card's agent, else it comes from a "factory(<agent>):"
// title. The pure half is in executor.mjs.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { assertGardenUrl } from "./garden-url.mjs";
import { appendLearned, cardIdRange, learnedLine, mergedCardPr, titleAgent, verifyMapPrompt, VERIFY_DIR, VERIFY_LABEL } from "./executor.mjs";

const { GITHUB_REPOSITORY: REPO, GITHUB_OUTPUT, SHA, WORK, BRIEF, RESULT, LEARNED, BASE = "garden", RUN_URL = "" } = process.env;
const log = (...xs) => console.log(new Date().toISOString(), ...xs);

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${argv.slice(0, 3).join(" ")} exited ${r.status}: ${(r.stderr || r.stdout || "").trim().slice(0, 800)}`);
  return r;
}
const gh = (...argv) => run("gh", argv).stdout;
const git = (...argv) => run("git", ["-C", WORK, ...argv]).stdout.trim();
const output = (k, v) => GITHUB_OUTPUT && appendFileSync(GITHUB_OUTPUT, `${k}=${v}\n`);

// The garden's REST root, from GARDEN_SUPABASE_URL (checked by the same guard
// the sweep uses). Null when unset: the card row is then not read or written.
function gardenRestRoot() {
  const url = process.env.GARDEN_SUPABASE_URL;
  if (!url) return null;
  assertGardenUrl(url);
  return `${url.replace(/\/$/, "")}/rest/v1`;
}

// The card row's agent; null when the card is gone or garden cannot be read.
async function cardAgent(ref) {
  const range = cardIdRange(ref);
  const key = process.env.SUPABASE_API_KEY;
  const root = gardenRestRoot();
  if (!range || !key || !root) return null;
  try {
    const res = await fetch(`${root}/factory_tasks?select=agent&id=gte.${range[0]}&id=lte.${range[1]}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json())[0]?.agent ?? null;
  } catch (e) {
    log(`card row unreadable (${e.message}); using the title`);
    return null;
  }
}

// The card's fix is merged: its quiet days start now (quietCards in
// general-rules.mjs closes it after 7 with no alert). A failure only logs.
async function markMerged(ref, at) {
  const range = cardIdRange(ref);
  const key = process.env.SUPABASE_API_KEY;
  const root = gardenRestRoot();
  if (!range || !key || !root) return;
  try {
    const res = await fetch(`${root}/factory_tasks?id=gte.${range[0]}&id=lte.${range[1]}&status=in.(open,in-progress)`, {
      method: "PATCH",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ merged_at: at, updated_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
    log(`card ${ref}: merged_at ${at}, quiet days start`);
  } catch (e) {
    log(`card merged_at not written (${e.message})`);
  }
}

const phase = process.argv[2];
if (phase === "find") {
  const pr = mergedCardPr(JSON.parse(gh("api", `repos/${REPO}/commits/${SHA}/pulls`)), SHA);
  if (!pr) {
    log(`${SHA.slice(0, 8)} is not a merged factory/card-* PR: nothing to do`);
  } else {
    await markMerged(pr.head.ref, pr.merged_at ?? new Date().toISOString());
    const files = JSON.parse(gh("api", "--paginate", "--slurp", `repos/${REPO}/pulls/${pr.number}/files`)).flat().map((f) => f.filename);
    writeFileSync(BRIEF, verifyMapPrompt({ pr, files }));
    log(`PR #${pr.number} (${pr.head.ref}) changed ${files.length} files; brief at ${BRIEF}`);
    const agent = (await cardAgent(pr.head.ref)) ?? titleAgent(pr.title);
    if (LEARNED && agent) writeFileSync(LEARNED, JSON.stringify({ agent, line: learnedLine(pr) }));
    log(`owner memory: ${agent ? `${agent} learns "${learnedLine(pr)}"` : "no agent for this card"}`);
    output("pr", pr.number);
  }
} else if (phase === "publish") {
  const pr = process.env.PR;
  // Only the verify folder ships; anything else the agent touched is dropped.
  // A commit the agent made anyway is folded back into the working tree.
  git("reset", "-q", "--soft", SHA);
  git("reset", "-q");
  const changed = git("status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean).map((l) => l.slice(3));
  const kept = changed.filter((f) => f.startsWith(VERIFY_DIR) && !/\/(evidence|node_modules)\//.test(f));
  const dropped = changed.filter((f) => !kept.includes(f));
  if (dropped.length) log(`dropped (outside ${VERIFY_DIR}): ${dropped.join(", ")}`);
  // Owner memory, built from the merged file so an agent edit to it is ignored.
  // Agent 'factory' (doctor and error cards) has no thinking file.
  const learned = LEARNED && existsSync(LEARNED) ? JSON.parse(readFileSync(LEARNED, "utf8")) : null;
  const memory = /^[a-z]+$/.test(learned?.agent ?? "") ? `agents/thinking/${learned.agent}.md` : null;
  const remembered = memory && run("git", ["-C", WORK, "cat-file", "-e", `${SHA}:${memory}`], { allowFail: true }).status === 0;
  if (remembered) {
    writeFileSync(`${WORK}/${memory}`, appendLearned(git("show", `${SHA}:${memory}`), learned.line));
    kept.push(memory);
    log(`${memory}: ${learned.line}`);
  }
  const memoryNote = remembered ? `Owner memory: \`${memory}\` learns "${learned.line.slice(2)}".\n\n` : "";
  const result = RESULT && existsSync(RESULT) ? JSON.parse(readFileSync(RESULT, "utf8")) : {};
  log(`agent: ${result.subtype ?? "no result"}, $${(result.total_cost_usd ?? 0).toFixed(2)}: ${(result.result ?? "").slice(0, 600)}`);
  if (!kept.length) {
    log("nothing to update");
  } else {
    const branch = `factory/verify-map-${pr}`;
    git("checkout", "-q", "-B", branch);
    git("add", "--", ...kept);
    git("-c", "user.name=factory-bot", "-c", "user.email=factory-bot@users.noreply.github.com", "commit", "-q", "-m", `docs(verify): map and owner memory after #${pr}`);
    git("push", "-f", `https://github.com/${REPO}.git`, `HEAD:refs/heads/${branch}`);
    run("gh", ["label", "create", VERIFY_LABEL, "--color", "0e8a16", "--description", "Verify-map update after a factory merge", "--force"], { allowFail: true });
    const body = `**Needs a person:** the factory never merges verify-map PRs (\`.claude/\` is protected).\n\n${result.result ?? "(no summary from the agent)"}\n\n${memoryNote}---\n\nAfter #${pr} merged into ${BASE}; [Actions run](${RUN_URL}). Files: ${kept.map((f) => `\`${f}\``).join(", ")}.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n`;
    const existing = gh("pr", "list", "--head", branch, "--json", "url", "--jq", ".[0].url").trim();
    const url = existing || gh("pr", "create", "--draft", "--base", BASE, "--head", branch, "--label", VERIFY_LABEL, "--title", `verify map: update after #${pr}`, "--body", body).trim().split("\n").at(-1);
    log(`${existing ? "updated" : "opened"} ${url}`);
  }
} else {
  throw new Error("usage: after-merge.mjs find|publish");
}
