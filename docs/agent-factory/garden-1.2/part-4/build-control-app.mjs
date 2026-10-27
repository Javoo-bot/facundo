// Rebuilds control-app.html from the garden database and git history, read-only.
// Run from anywhere in the repo, once a day (REFRESH.md is the morning routine):
//   node docs/agent-factory/garden-1.2/part-4/build-control-app.mjs
// Needs GARDEN_SUPABASE_URL in the environment. The garden key is
// SUPABASE_API_KEY from the environment (the cloud routine),
// else from FACTORY_ENV_FILE or the repo's .env (a local run). Merged PRs come
// from the garden branch's merge commits, so no GitHub token is needed. The pure half is
// control-app.mjs.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { buildData, mergesFromLog, receiptsFrom, rulesView } from "./control-app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
// The garden database is not part of this repo: point GARDEN_SUPABASE_URL at your own project.
const GARDEN_URL = process.env.GARDEN_SUPABASE_URL;
if (!GARDEN_URL) throw new Error("GARDEN_SUPABASE_URL is not set (the garden database URL)");
const GARDEN = `${GARDEN_URL.replace(/[/]+$/, "")}/rest/v1/`;

function gardenKey() {
  if (process.env.SUPABASE_API_KEY) return process.env.SUPABASE_API_KEY;
  const envFile = process.env.FACTORY_ENV_FILE ?? join(repo, ".env");
  const key = existsSync(envFile) && readFileSync(envFile, "utf8").match(/^\s*SUPABASE_API_KEY\s*=\s*["']?([^"'\r\n]+)/m)?.[1];
  if (!key) throw new Error(`SUPABASE_API_KEY is not set and not found in ${envFile}`);
  return key;
}
const key = gardenKey();

async function all(query) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(GARDEN + query, { headers: { apikey: key, Authorization: `Bearer ${key}`, Range: `${from}-${from + 999}` } });
    if (!r.ok) throw new Error(`${query}: ${r.status} ${await r.text()}`);
    const page = await r.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

// Factory fixes merge into garden, not main.
function gardenLog() {
  for (const ref of ["origin/garden", "garden"]) {
    try {
      return execFileSync("git", ["log", ref, "--first-parent", "--format=%cI%x09%s"], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean);
    } catch { /* try the next ref */ }
  }
  throw new Error("No garden branch in this checkout: run git fetch origin garden first.");
}

// Receipts Claude in Slack writes to the control-room-log branch, one JSON file each under log/
// (.claude/rules/slack-roles.md). No branch yet means no receipts, not an error.
function receiptFiles() {
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
  for (const ref of ["origin/control-room-log", "control-room-log"]) {
    try {
      return git("ls-tree", "-r", "--name-only", ref, "--", "log/").split("\n").filter((p) => p.endsWith(".json"))
        .map((p) => git("show", `${ref}:${p}`));
    } catch { /* try the next ref */ }
  }
  return [];
}

const [events, tasks, runs] = await Promise.all([
  all("agent_events?select=case_id,seq,type,data,created_at&order=case_id,seq"),
  all("factory_tasks?select=id,agent,title,source,status,fingerprint,created_at&order=created_at"),
  all("factory_runs?select=id,task_id,started_at,finished_at,outcome,notes,pr_url&order=started_at"),
]);
const merges = mergesFromLog(gardenLog());
const audit = JSON.parse(readFileSync(join(here, "test-audit.json"), "utf8"));

// The rules each manager owns, from the same sources as the rule map (../build-rule-map.mjs):
// lifecycle.ts has no imports, so a .mts copy loads with Node's type stripping.
async function rules() {
  try {
    const tmp = join(mkdtempSync(join(tmpdir(), "control-room-")), "lifecycle.mts");
    copyFileSync(join(repo, "dashboard/lib/lifecycle.ts"), tmp);
    const { PHASES, CROSS_CUTTING } = await import(pathToFileURL(tmp).href);
    const situations = Object.fromEntries([...PHASES.flatMap((p) => p.stages.flatMap((s) => s.branches ?? [])), ...CROSS_CUTTING].map((b) => [b.id, b]));
    return rulesView(JSON.parse(readFileSync(join(here, "..", "general-rules.json"), "utf8")), situations);
  } catch (e) {
    console.error(`rules skipped: ${e.message}`);
    return {};
  }
}

const now = new Date().toISOString();
const data = buildData({ tasks, runs, events, merges, audit, now, receipts: receiptsFrom(receiptFiles(), now), rules: await rules() });
const safe = (s) => s.replace(/<\//g, "<\\/");
const page = readFileSync(join(here, "control-app.template.html"), "utf8").replace("__DATA__", () => safe(JSON.stringify(data)));
writeFileSync(join(here, "control-app.html"), page);
const top = data.managers[data.order[0]];
console.log(`control-app.html: ${tasks.length} cards, ${runs.length} runs, ${events.length} events, ${Object.keys(merges).length} merged PRs, ${data.receipts.length} Slack receipts; top: ${top.name} (${top.critCount} red)${data.silent ? `; garden silent for ${data.silent.hours} h` : ""}`);
