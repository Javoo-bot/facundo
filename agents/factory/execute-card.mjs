// Works ONE open factory card in a locked sandbox and turns it into a draft PR.
//
//   node agents/factory/execute-card.mjs              oldest eligible card
//   node agents/factory/execute-card.mjs --card <id>  that card (must be open)
//   node agents/factory/execute-card.mjs --dry-run    print the pick and its brief, write nothing
//   node agents/factory/execute-card.mjs --probe      the task-010 fence probes, no card
//
// A run is three phases. Without --phase all three run in one process (the
// laptop). GitHub Actions (.github/workflows/factory-execute.yml) runs each in
// its own job, so the job that runs the agent never holds the database key or a
// token that can push:
//
//   --phase claim    garden key: pick and claim a card, write <dir>/in (brief,
//                    agent settings, git bundle of the base branch) and run.json
//   --phase agent    Claude token only: run the agent on <dir>/in, its commits
//                    come back as <dir>/out/result.bundle
//   --phase publish  garden key + push rights: push the branch, open the draft
//                    PR, record the outcome on factory_runs
//
//   --runner box     (default) the agent runs in the Docker box (agents/factory/box/)
//   --runner local   the agent runs on this machine with box/run.sh; only for a
//                    throwaway machine such as a GitHub runner, never a laptop
//   --dir <path>     the run folder (required with --phase)
//
// Never merges. Env (all optional): SUPABASE_API_KEY (the garden secret key,
// else read from FACTORY_ENV_FILE), CLAUDE_CODE_OAUTH_TOKEN, FACTORY_PSTACK
// (pstack plugin dir), FACTORY_BASE (garden), FACTORY_MODEL (sonnet),
// FACTORY_MINUTES (60), FACTORY_BUDGET_USD (5), FACTORY_MAX_TURNS (200).

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentUsage, branchFor, buildPrompt, decide, pickCard, prBody, prTitle, staleRuns, timedOutExit } from "./executor.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STATE = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "Facundo");
const GARDEN_URL = "https://your-project-ref.supabase.co";
const ENV_FILE = process.env.FACTORY_ENV_FILE ?? "/path/to/facundo/.env";
const BASE = process.env.FACTORY_BASE ?? "garden";
const MODEL = process.env.FACTORY_MODEL ?? "sonnet";
const MINUTES = Number(process.env.FACTORY_MINUTES ?? 60);
const BUDGET = process.env.FACTORY_BUDGET_USD ?? "5";
const MAX_TURNS = process.env.FACTORY_MAX_TURNS ?? "200";
const IMAGE = "facundo-factory-box";
const RUNNERS = ["box", "local"];
const PHASES = ["claim", "agent", "publish"];

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const forcedCard = opt("--card");
const runner = opt("--runner") ?? "box";
const phase = opt("--phase");
if (!RUNNERS.includes(runner)) throw new Error(`--runner must be one of ${RUNNERS.join(", ")}`);
if (phase && !PHASES.includes(phase)) throw new Error(`--phase must be one of ${PHASES.join(", ")}`);
if (phase && !opt("--dir")) throw new Error("--phase needs --dir");

const log = (...xs) => console.log(new Date().toISOString(), ...xs);

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: "utf8", maxBuffer: 64 << 20, ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${argv.slice(0, 3).join(" ")} exited ${r.status}: ${(r.stderr || r.stdout || r.error?.message || "").trim().slice(0, 800)}`);
  }
  return r;
}
const git = (...argv) => run("git", ["-C", REPO, ...argv]).stdout.trim();

// Only the one key asked for, so no other secret from the file reaches any
// child process.
function envKey(name) {
  if (process.env[name]) return process.env[name];
  const line = readFileSync(ENV_FILE, "utf8").split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} not set and not in ${ENV_FILE}`);
  return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
}

// Step outputs for the workflow; a no-op off GitHub Actions.
function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

// --- garden queue (Supabase REST, secret key) -------------------------------

let KEY = null;
async function rest(method, path, body, extra = {}) {
  KEY ??= envKey("SUPABASE_API_KEY");
  const res = await fetch(`${GARDEN_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=representation", ...extra },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path.split("?")[0]}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const CARD_FIELDS = "id,agent,title,summary,evidence,source,status,fingerprint,latest_signal_at,created_at,runs:factory_runs(id,started_at,finished_at)";

async function closeRun(runId, cardId, d, extra = {}) {
  const now = new Date().toISOString();
  await rest("PATCH", `factory_runs?id=eq.${runId}`, { finished_at: now, outcome: d.outcome, notes: d.notes, ...extra });
  await rest("PATCH", `factory_tasks?id=eq.${cardId}`, { status: d.cardStatus, updated_at: now });
}

// --- the box (Docker, laptop) -------------------------------------------------

function findDocker() {
  const candidates = [
    join(process.env.LOCALAPPDATA ?? "", "Programs/DockerDesktop/resources/bin/docker.exe"),
    join(process.env.ProgramFiles ?? "C:/Program Files", "Docker/Docker/resources/bin/docker.exe"),
  ];
  if (run("docker", ["--version"], { allowFail: true }).status === 0) return "docker";
  const found = candidates.find(existsSync);
  if (!found) throw new Error("docker.exe not found; is Docker Desktop installed?");
  // docker.exe calls its credential helper from the same folder by name.
  process.env.PATH = `${dirname(found)};${process.env.PATH}`;
  return found;
}

async function ensureDaemon(docker) {
  const up = () => run(docker, ["version", "--format", "{{.Server.Version}}"], { allowFail: true }).status === 0;
  if (up()) return;
  const desktop = join(dirname(docker), "../../Docker Desktop.exe");
  log("docker daemon down; starting Docker Desktop");
  if (existsSync(desktop)) spawn(desktop, [], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 48; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    if (up()) return;
  }
  throw new Error("Docker Desktop did not start within 4 minutes");
}

function pstackDir() {
  if (process.env.FACTORY_PSTACK) return process.env.FACTORY_PSTACK;
  const cache = join(homedir(), ".claude/plugins/cache");
  const dirs = readdirSync(cache).flatMap((m) => {
    const p = join(cache, m, "pstack");
    return existsSync(p) ? readdirSync(p).map((v) => ({ v, p: join(p, v) })) : [];
  }).filter((d) => existsSync(join(d.p, "skills/poteto-mode/SKILL.md")));
  dirs.sort((a, b) => a.v.localeCompare(b.v, undefined, { numeric: true }));
  if (!dirs.length) throw new Error("pstack plugin not installed on this machine");
  return dirs.at(-1).p;
}

// CLAUDE_CODE_OAUTH_TOKEN (a GitHub secret on Actions) wins, then a long-lived
// token from `claude setup-token` saved to %LOCALAPPDATA%\Facundo\claude-oauth-token.
// Without either, the host's own login is borrowed: its access token is valid
// for hours and the host CLI refreshes it when it has expired.
function claudeToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const saved = join(STATE, "claude-oauth-token");
  if (existsSync(saved)) return readFileSync(saved, "utf8").trim();
  const credFile = join(homedir(), ".claude/.credentials.json");
  const read = () => JSON.parse(readFileSync(credFile, "utf8")).claudeAiOauth;
  let oauth = read();
  if (oauth.expiresAt - Date.now() < 5 * 60_000) {
    log("host Claude login expired; refreshing it with one tiny host call");
    run("claude", ["-p", "Reply with the word ok.", "--model", "haiku", "--max-budget-usd", "0.05"], { shell: true, timeout: 120_000, allowFail: true });
    oauth = read();
  }
  const left = Math.round((oauth.expiresAt - Date.now()) / 60_000);
  if (left < 5) throw new Error("no usable Claude login: run `claude setup-token` once (see agents/factory/README.md)");
  if (left < MINUTES) log(`warning: borrowed Claude login has ${left} min left, less than the ${MINUTES} min cap`);
  return oauth.accessToken;
}

const agentEnv = () => ({ FACTORY_MODEL: MODEL, FACTORY_BUDGET_USD: BUDGET, FACTORY_MINUTES: String(MINUTES), FACTORY_MAX_TURNS: MAX_TURNS });

async function watch(child, onTimeout) {
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  let timedOut = false;
  // run.sh's own `timeout` stops claude at the cap; this is the backstop.
  const timer = setTimeout(() => { timedOut = true; onTimeout(); }, (MINUTES + 5) * 60_000);
  const code = await new Promise((r) => child.on("close", r));
  clearTimeout(timer);
  return { code, timedOut, output };
}

// One container, the only host folders it sees: in (read-only), pstack
// (read-only), out (read-write).
async function box(docker, mode, dir, env) {
  const name = `factory-${mode}-${Date.now()}`;
  const argv = [
    "run", "--rm", "--name", name,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "2048", "--memory", "6g",
    "-v", `${join(dir, "in")}:/in:ro`,
    "-v", `${pstackDir()}:/opt/pstack:ro`,
    "-v", `${join(dir, "out")}:/out`,
    "-e", "CLAUDE_CODE_OAUTH_TOKEN",
    ...Object.keys(env).flatMap((k) => ["-e", `${k}=${env[k]}`]),
    IMAGE, mode,
  ];
  const child = spawn(docker, argv, { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: claudeToken() }, stdio: ["ignore", "pipe", "pipe"] });
  return watch(child, () => run(docker, ["kill", name], { allowFail: true }));
}

async function prepareBox() {
  const docker = findDocker();
  await ensureDaemon(docker);
  run(docker, ["build", "-q", "-t", IMAGE, join(REPO, "agents/factory/box")]);
  return docker;
}

// The same run.sh straight on this machine. Its environment is built from
// nothing, so no key or token of the calling process reaches the agent.
async function local(dir, env) {
  const childEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME ?? homedir(), LANG: "C.UTF-8",
    CLAUDE_CODE_OAUTH_TOKEN: claudeToken(),
    FACTORY_IN: join(dir, "in"), FACTORY_OUT: join(dir, "out"), FACTORY_PSTACK: pstackDir(), FACTORY_WORK: join(dir, "work"),
    ...env,
  };
  const child = spawn("bash", [join(REPO, "agents/factory/box/run.sh"), "work"], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  return watch(child, () => child.kill("SIGKILL"));
}

// --- phases -----------------------------------------------------------------------

const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const outFile = (dir, f) => (existsSync(join(dir, "out", f)) ? readFileSync(join(dir, "out", f), "utf8") : "");

function runDir(id) {
  const dir = opt("--dir") ? resolve(opt("--dir")) : join(STATE, "factory-runs", id);
  for (const d of ["in", "out"]) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}

async function claim() {
  const now = Date.now();
  const cards = await rest("GET", `factory_tasks?status=in.(open,in-progress)&select=${CARD_FIELDS}`);
  for (const id of staleRuns(cards, now)) {
    log(`closing stale run ${id}`);
    await rest("PATCH", `factory_runs?id=eq.${id}`, { finished_at: new Date().toISOString(), outcome: "failed", notes: "Never finished: the executor died with its host." });
    const card = cards.find((c) => c.runs.some((r) => r.id === id));
    if (card.status === "in-progress") await rest("PATCH", `factory_tasks?id=eq.${card.id}`, { status: "open", updated_at: new Date().toISOString() });
    card.status = "open";
    card.runs.find((r) => r.id === id).finished_at = new Date().toISOString();
  }
  const card = forcedCard ? cards.find((c) => c.id === forcedCard && c.status === "open") : pickCard(cards, now);
  if (!card) return log(forcedCard ? `card ${forcedCard} is not open` : "no card to work");

  const branch = branchFor(card);
  const agentFile = readFileSync(join(REPO, "agents/thinking", `${card.agent}.md`), "utf8");
  log(`card ${card.id} (${card.agent}): ${card.title}`);
  if (flag("--dry-run")) return console.log(buildPrompt({ card, agentFile, base: BASE, branch }));

  const docker = runner === "box" ? await prepareBox() : null;
  const [claimed] = await rest("PATCH", `factory_tasks?id=eq.${card.id}&status=eq.open`, { status: "in-progress", updated_at: new Date().toISOString() });
  if (!claimed) return log("another worker took this card first");
  const [runRow] = await rest("POST", "factory_runs", { task_id: card.id, branch });
  log(`run ${runRow.id} started`);

  try {
    const dir = runDir(runRow.id);
    const reportPath = runner === "box" ? "/out/report.md" : join(dir, "out", "report.md");
    writeFileSync(join(dir, "in/prompt.md"), buildPrompt({ card, agentFile, base: BASE, branch, reportPath }));
    copyFileSync(join(REPO, "agents/factory/box/agent-settings.json"), join(dir, "in/agent-settings.json"));
    git("fetch", "-q", "origin", `+refs/heads/${BASE}:refs/factory/base`);
    git("bundle", "create", "-q", join(dir, "in/base.bundle"), "refs/factory/base");
    const state = { card, run: runRow, branch, baseSha: git("rev-parse", "refs/factory/base"), runner };
    writeFileSync(join(dir, "run.json"), JSON.stringify(state, null, 2));
    output("run_id", runRow.id);
    return { dir, docker, state };
  } catch (e) {
    await closeRun(runRow.id, card.id, { outcome: "failed", cardStatus: "open", notes: `Executor error: ${e.message}`.slice(0, 1000) });
    throw e;
  }
}

async function agent(dir, docker) {
  const { branch } = readJson(join(dir, "run.json"));
  // An artifact round trip drops empty folders.
  mkdirSync(join(dir, "out"), { recursive: true });
  const env = { FACTORY_BRANCH: branch, ...agentEnv() };
  const result = runner === "box" ? await box(docker ?? await prepareBox(), "work", dir, env) : await local(dir, env);
  const timedOut = result.timedOut || timedOutExit(outFile(dir, "claude-exit").trim());
  writeFileSync(join(dir, "out/runner.json"), JSON.stringify({ code: result.code, timedOut, tail: result.output.slice(-2000) }));
  log(`${runner} exited ${result.code}${timedOut ? " (time cap)" : ""}`);
}

async function publish(dir) {
  const { card, run: runRow, branch, baseSha } = readJson(join(dir, "run.json"));
  try {
    const ran = existsSync(join(dir, "out/runner.json")) ? readJson(join(dir, "out/runner.json")) : { code: null, timedOut: false, tail: "" };
    git("update-ref", "refs/factory/base", baseSha);
    const bundle = join(dir, "out/result.bundle");
    let commits = 0, files = [];
    if (existsSync(bundle)) {
      git("fetch", "-q", bundle, `+refs/heads/factory-result:refs/heads/${branch}`);
      commits = Number(git("rev-list", "--count", `refs/factory/base..${branch}`));
      files = git("diff", "--name-only", `refs/factory/base...${branch}`).split("\n").filter(Boolean);
    }
    const report = outFile(dir, "report.md");
    const d = decide({ report, commits, files, timedOut: ran.timedOut, boxExit: ran.code ?? -1 });
    if (ran.code === null) d.notes = "The agent step never finished (cancelled or crashed). " + d.notes;
    if (!report) d.notes += ` Last output: ${(outFile(dir, "agent.err") || ran.tail).trim().slice(-500)}`;
    const usage = agentUsage(outFile(dir, "agent.jsonl"));
    if (usage) log(`agent cost $${usage.costUsd}, ${usage.turns} turns, ${usage.stop}`);

    let pr_url = null;
    if (d.openPr) {
      git("push", "-q", "origin", `refs/heads/${branch}:refs/heads/${branch}`);
      const bodyFile = join(dir, "pr-body.md");
      writeFileSync(bodyFile, prBody({ card, report, decision: d, run: runRow }));
      pr_url = run("gh", ["pr", "create", "--draft", "--base", BASE, "--head", branch, "--title", prTitle(card), "--body-file", bodyFile], { cwd: REPO }).stdout.trim().split("\n").at(-1);
      log(`draft PR ${pr_url}`);
    }
    await closeRun(runRow.id, card.id, d, { pr_url, branch: d.openPr ? branch : null });
    log(`outcome ${d.outcome}, card ${d.cardStatus}: ${d.notes.slice(0, 300)}`);
    output("pr_url", pr_url ?? "");
  } catch (e) {
    await closeRun(runRow.id, card.id, { outcome: "failed", cardStatus: "open", notes: `Executor error: ${e.message}`.slice(0, 1000) });
    throw e;
  }
}

async function work() {
  if (phase === "claim") return claim();
  if (phase === "agent") return agent(resolve(opt("--dir")));
  if (phase === "publish") return publish(resolve(opt("--dir")));
  const claimed = await claim();
  if (!claimed) return;
  try {
    await agent(claimed.dir, claimed.docker);
  } catch (e) {
    log(`agent error: ${e.message}`);
  }
  await publish(claimed.dir);
}

async function probe() {
  const docker = await prepareBox();
  const dir = runDir(`probe-${Date.now()}`);
  const shell = await box(docker, "probe", dir, {});
  const agentRun = await box(docker, "probe-agent", dir, { FACTORY_MODEL: MODEL });
  const desktop = join(homedir(), "Desktop");
  const leaked = readdirSync(desktop).filter((f) => f.startsWith("factory-probe"));
  console.log(shell.output, "\n--- the agent itself ---\n", agentRun.output);
  console.log(`host check: ${leaked.length ? `FILES APPEARED on the Desktop: ${leaked.join(", ")}` : "no probe file appeared on the host Desktop"}`);
  console.log(`evidence: ${dir}`);
}

mkdirSync(STATE, { recursive: true });
try {
  await (flag("--probe") ? probe() : work());
} catch (e) {
  log(`error: ${e.message}`);
  process.exitCode = 1;
}
