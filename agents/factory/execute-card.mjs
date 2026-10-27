// Works ONE open factory card in a locked sandbox and turns it into a draft PR.
//
//   node agents/factory/execute-card.mjs              oldest eligible card
//   node agents/factory/execute-card.mjs --card <id>  that card (must be open)
//   node agents/factory/execute-card.mjs --dry-run    print the pick and its brief, write nothing
//   ... --dry-run --card-file <json>                  the same for a card in a file, no database
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
//   --lane doctor    work only source 'factory' cards (.github/workflows/factory-doctor.yml):
//                    brief from agents/factory/doctor.md, PRs always needs-human,
//                    parked after DOCTOR_TRIES
//
// Merges only free-lane PRs (wording or look, executor.mjs FREE_PATHS) and
// only with FACTORY_AUTOMERGE=1. Env (all optional): SUPABASE_API_KEY (the garden secret key,
// else read from FACTORY_ENV_FILE), CLAUDE_CODE_OAUTH_TOKEN, FACTORY_PSTACK
// (pstack plugin dir), FACTORY_BASE (garden), FACTORY_MODEL (claude-haiku-5-5; a risky card always
// gets claude-sonnet-5-5, executor.mjs modelFor),
// FACTORY_MINUTES (60), FACTORY_BUDGET_USD (5), FACTORY_MAX_TURNS (200),
// FACTORY_MANAGER_BUDGET_USD (0.5, each manager step).
//
// Managers (managers.mjs): a card with an owning manager gets a brief before
// Mike runs and a check of his commits after. Both run in the agent phase (they
// need Claude); their events ride in out/manager.json and publish applies the
// verdict and logs them to agent_events (case_id card:<id>).

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JESSICA, applyCheck, briefPrompt, briefSection, caseId, checkLine, checkPrompt, eventRows, generalRule, managerFor, managerName, managerState, parseBrief, parseVerdict } from "./managers.mjs";
import { DEFAULT_MODEL, modelFor, riskyArea, actionsRunUrl, agentUsage, branchFor, briefPath, buildPrompt, decide, moveGoodTag, parkIfSpent, parseReport, pickCard, prBody, prTitle, staleRuns, timedOutExit, GOOD_TAG, PR_LINE_LIMIT, changeGraph, changedLines, diffAnchor, parseNumstat, splitPoint } from "./executor.mjs";
import { questionIssue } from "./questions.mjs";
import { assertGardenUrl } from "./garden-url.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const STATE = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "Facundo");
const ENV_FILE = process.env.FACTORY_ENV_FILE ?? "/path/to/facundo/.env";
const BASE = process.env.FACTORY_BASE ?? "garden";
const MODEL = process.env.FACTORY_MODEL ?? DEFAULT_MODEL;
const MINUTES = Number(process.env.FACTORY_MINUTES ?? 60);
const BUDGET = process.env.FACTORY_BUDGET_USD ?? "5";
const MAX_TURNS = process.env.FACTORY_MAX_TURNS ?? "200";
const MANAGER_BUDGET = process.env.FACTORY_MANAGER_BUDGET_USD ?? "0.5";
// The free lane merges its own PRs only when this is "1" (the workflow sets it).
const AUTOMERGE = process.env.FACTORY_AUTOMERGE === "1";
const IMAGE = "facundo-factory-box";
const RUNNERS = ["box", "local"];
const PHASES = ["claim", "agent", "publish"];

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const forcedCard = opt("--card");
const runner = opt("--runner") ?? "box";
const phase = opt("--phase");
const lane = opt("--lane") ?? "cards";
if (!["cards", "doctor"].includes(lane)) throw new Error("--lane must be cards or doctor");
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
let GARDEN_URL = null;
async function rest(method, path, body, extra = {}) {
  KEY ??= envKey("SUPABASE_API_KEY");
  if (!GARDEN_URL) {
    GARDEN_URL = envKey("GARDEN_SUPABASE_URL").replace(/\/$/, "");
    process.env.GARDEN_SUPABASE_URL ??= GARDEN_URL;
    assertGardenUrl(GARDEN_URL);
  }
  const res = await fetch(`${GARDEN_URL}/rest/v1/${path}`, {
    method,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", Prefer: "return=representation", ...extra },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path.split("?")[0]}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const CARD_FIELDS = "id,agent,title,summary,evidence,source,status,fingerprint,latest_signal_at,created_at,manager,reopened_at,question,answer,runs:factory_runs(id,started_at,finished_at)";

// mergedAt: the free lane merged the PR, so the card's quiet days start now.
// cardExtra: more card columns to set with the status (a run's question).
async function closeRun(runId, cardId, d, extra = {}, mergedAt = null, cardExtra = {}) {
  const now = new Date().toISOString();
  await rest("PATCH", `factory_runs?id=eq.${runId}`, { finished_at: now, outcome: d.outcome, notes: d.notes, ...extra });
  await rest("PATCH", `factory_tasks?id=eq.${cardId}`, { status: d.cardStatus, updated_at: now, ...(mergedAt ? { merged_at: mergedAt } : {}), ...cardExtra });
}

// The card's manager events (agent_events, case_id card:<id>), oldest first.
// A garden without the table reads as no history: the manager writes a brief.
async function cardEvents(card) {
  try {
    return await rest("GET", `agent_events?case_id=eq.${encodeURIComponent(caseId(card))}&select=seq,type,data&order=seq.asc`);
  } catch (e) {
    log(`manager history unreadable, starting fresh: ${e.message.slice(0, 200)}`);
    return [];
  }
}

// Appends after the case's last seq; a clash with another writer retries. A
// failure only logs: the run's outcome is already decided.
async function logEvents(card, manager, runId, events) {
  if (!events.length) return;
  try {
    for (let i = 0; i < 3; i++) {
      const [last] = await rest("GET", `agent_events?case_id=eq.${encodeURIComponent(caseId(card))}&select=seq&order=seq.desc&limit=1`);
      try {
        await rest("POST", "agent_events", eventRows(card, last?.seq ?? 0, events, { manager, runId, now: new Date().toISOString() }));
        return log(`manager events: ${events.map((e) => e.type).join(", ")}`);
      } catch (e) {
        if (!/\b409\b|23505/.test(e.message)) throw e;
      }
    }
    throw new Error("seq kept clashing");
  } catch (e) {
    log(`manager events not logged: ${e.message.slice(0, 300)}`);
  }
}

// The agent was not sure: put its question where the owner answers. A draft PR
// already carries it at the top; with no code, a GitHub issue does. If the
// issue cannot be opened, the card falls back to needs-human (in-progress), so
// it never waits on a question nobody can see.
function askOwner(dir, card, runRow, d, prUrl) {
  let issue_url = null;
  if (d.askIssue) {
    const { title, body } = questionIssue({ card, question: d.question, run: runRow, runUrl: actionsRunUrl(process.env) });
    const bodyFile = join(dir, "question-issue.md");
    writeFileSync(bodyFile, body);
    const r = run("gh", ["issue", "create", "--title", title, "--body-file", bodyFile], { cwd: REPO, allowFail: true });
    issue_url = r.status === 0 ? r.stdout.trim().split("\n").at(-1) : null;
    if (!issue_url) {
      const why = (r.stderr || r.stdout || "").trim().slice(0, 300);
      return { d: { ...d, outcome: "needs-human", cardStatus: "in-progress", question: undefined, notes: `${d.notes} Could not open the question issue: ${why}` }, cardExtra: {} };
    }
    log(`question issue ${issue_url}`);
  }
  const question = { ...d.question, round: (card.question?.round ?? 0) + 1, asked_at: new Date().toISOString(), run_id: runRow.id, pr_url: prUrl, issue_url };
  return { d, cardExtra: { question } };
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

const agentEnv = (card) => ({ FACTORY_MODEL: modelFor(card, MODEL), FACTORY_BUDGET_USD: BUDGET, FACTORY_MINUTES: String(MINUTES), FACTORY_MAX_TURNS: MAX_TURNS, FACTORY_MANAGER_BUDGET_USD: MANAGER_BUDGET });

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
// nothing, so no key or token of the calling process reaches the agent. When
// the local garden booted (its notes file exists), the verify skill's database
// is pointed at it (box/verify-local.mjs).
async function local(dir, env, mode = "work") {
  const garden = existsSync(join(dir, "garden-notes.txt"));
  const childEnv = {
    ...(garden && { NODE_OPTIONS: `--import ${pathToFileURL(join(REPO, "agents/factory/box/verify-local.mjs")).href}` }),
    PATH: process.env.PATH, HOME: process.env.HOME ?? homedir(), LANG: "C.UTF-8",
    CLAUDE_CODE_OAUTH_TOKEN: claudeToken(),
    FACTORY_IN: join(dir, "in"), FACTORY_OUT: join(dir, "out"), FACTORY_PSTACK: pstackDir(), FACTORY_WORK: join(dir, "work"),
    ...env,
  };
  const child = spawn("bash", [join(REPO, "agents/factory/box/run.sh"), mode], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  return watch(child, () => child.kill("SIGKILL"));
}

// --- phases -----------------------------------------------------------------------

const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const listFiles = (d) => (existsSync(d) ? readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) : []);
const outFile = (dir, f) => (existsSync(join(dir, "out", f)) ? readFileSync(join(dir, "out", f), "utf8") : "");

function runDir(id) {
  const dir = opt("--dir") ? resolve(opt("--dir")) : join(STATE, "factory-runs", id);
  for (const d of ["in", "out"]) mkdirSync(join(dir, d), { recursive: true });
  return dir;
}

async function claim() {
  const now = Date.now();
  const cardFile = flag("--dry-run") && opt("--card-file");
  const cards = cardFile ? [{ status: "open", created_at: new Date(0).toISOString(), ...readJson(cardFile), runs: [] }]
    : await rest("GET", `factory_tasks?status=in.(open,in-progress)&select=${CARD_FIELDS}`);
  for (const id of staleRuns(cards, now)) {
    log(`closing stale run ${id}`);
    await rest("PATCH", `factory_runs?id=eq.${id}`, { finished_at: new Date().toISOString(), outcome: "failed", notes: "Never finished: the executor died with its host." });
    const card = cards.find((c) => c.runs.some((r) => r.id === id));
    if (card.status === "in-progress") await rest("PATCH", `factory_tasks?id=eq.${card.id}`, { status: "open", updated_at: new Date().toISOString() });
    card.status = "open";
    card.runs.find((r) => r.id === id).finished_at = new Date().toISOString();
  }
  const inLane = (c) => (c.source === "factory") === (lane === "doctor");
  const card = forcedCard ? cards.find((c) => c.id === forcedCard && c.status === "open" && inLane(c)) : pickCard(cards, now, { lane });
  if (!card) return log(forcedCard ? `card ${forcedCard} is not open in the ${lane} lane` : `no card to work in the ${lane} lane`);

  const branch = branchFor(card);
  const agentPath = briefPath(card);
  const agentFile = readFileSync(join(REPO, agentPath), "utf8");
  log(`card ${card.id} (${card.agent}): ${card.title}`);
  log(`model ${modelFor(card, MODEL)}${riskyArea(card) ? ` (risky: ${riskyArea(card)}, plans with pstack:arena)` : ""}`);
  const managerId = managerFor(card);
  log(`manager ${managerId ? managerName(managerId) : "none"}`);
  // Money stays with Jessica (a person): she briefs and checks it herself, so
  // the card never goes to Mike. It is parked with a to_jessica event.
  if (managerId === JESSICA.id) {
    if (flag("--dry-run")) return log("goes to Jessica, not to Mike");
    const why = `money (${generalRule(card)}): Jessica briefs and checks every payout fix herself`;
    const [parked] = await rest("PATCH", `factory_tasks?id=eq.${card.id}&status=eq.open`, { status: "parked", updated_at: new Date().toISOString() });
    if (parked) await logEvents(card, JESSICA.id, null, [{ type: "to_jessica", data: { why } }]);
    return log(parked ? `parked for Jessica: ${why}` : "another worker took this card first");
  }
  const manager = managerId && { id: managerId, ...managerState(flag("--card-file") ? [] : await cardEvents(card)) };
  if (manager) log(manager.brief ? `brief v${manager.brief.version} kept, sent back ${manager.sendBacks} time(s)` : `brief v${manager.nextVersion} to write`);
  if (flag("--dry-run")) return console.log(buildPrompt({ card, agentFile, agentPath, base: BASE, branch }));

  const docker = runner === "box" ? await prepareBox() : null;
  const [claimed] = await rest("PATCH", `factory_tasks?id=eq.${card.id}&status=eq.open`, { status: "in-progress", updated_at: new Date().toISOString() });
  if (!claimed) return log("another worker took this card first");
  const [runRow] = await rest("POST", "factory_runs", { task_id: card.id, branch });
  log(`run ${runRow.id} started`);

  try {
    const dir = runDir(runRow.id);
    const reportPath = runner === "box" ? "/out/report.md" : join(dir, "out", "report.md");
    // On a GitHub runner the agent job boots its own garden (box/local-garden.sh).
    writeFileSync(join(dir, "in/prompt.md"), buildPrompt({ card, agentFile, agentPath, base: BASE, branch, reportPath, localGarden: runner === "local" }));
    copyFileSync(join(REPO, "agents/factory/box/agent-settings.json"), join(dir, "in/agent-settings.json"));
    git("fetch", "-q", "origin", `+refs/heads/${BASE}:refs/factory/base`);
    git("bundle", "create", "-q", join(dir, "in/base.bundle"), "refs/factory/base");
    const state = { card, run: runRow, branch, baseSha: git("rev-parse", "refs/factory/base"), runner, manager };
    writeFileSync(join(dir, "run.json"), JSON.stringify(state, null, 2));
    output("run_id", runRow.id);
    return { dir, docker, state };
  } catch (e) {
    await closeRun(runRow.id, card.id, { outcome: "failed", cardStatus: "open", notes: `Executor error: ${e.message}`.slice(0, 1000) });
    throw e;
  }
}

// The manager's one answer (Claude Code's --output-format json), or "".
function managerAnswer(dir, step, ran) {
  if (ran.code !== 0 || ran.timedOut) log(`manager ${step} exited ${ran.code}${ran.timedOut ? " (time cap)" : ""}: ${ran.output.trim().slice(-300)}`);
  try {
    return JSON.parse(outFile(dir, `manager-${step}.json`)).result ?? "";
  } catch {
    return "";
  }
}

const repoFile = (path) => (existsSync(join(REPO, path)) ? readFileSync(join(REPO, path), "utf8") : "");

async function agent(dir, docker) {
  const { branch, card, manager } = readJson(join(dir, "run.json"));
  // An artifact round trip drops empty folders.
  mkdirSync(join(dir, "out"), { recursive: true });
  const env = { FACTORY_BRANCH: branch, ...agentEnv(card) };
  const inBox = async (mode, extra = {}) => (runner === "box"
    ? box(docker ??= await prepareBox(), mode, dir, { ...env, ...extra })
    : local(dir, { ...env, ...extra }, mode));

  // 1. Brief: the owning manager says what "fixed" means, once per card version.
  let prompt = readFileSync(join(dir, "in/prompt.md"), "utf8");
  const m = manager && { manager: manager.id, brief: manager.brief, sendBacks: manager.sendBacks, events: [], verdict: null };
  const save = () => m && writeFileSync(join(dir, "out/manager.json"), JSON.stringify(m, null, 2));
  if (m) {
    const roleFile = repoFile(`agents/factory/managers/${m.manager}.md`);
    if (!m.brief) {
      const version = manager.nextVersion;
      writeFileSync(join(dir, "out/manager-brief-prompt.md"), briefPrompt({ card, manager: m.manager, roleFile, agentFile: repoFile(`agents/thinking/${card.agent}.md`), version }));
      const ran = await inBox("manager", { FACTORY_MANAGER_STEP: "brief" });
      const text = parseBrief(managerAnswer(dir, "brief", ran));
      if (text) {
        m.brief = { version, text };
        m.events.push({ type: "brief_written", at: new Date().toISOString(), data: { version, rule: generalRule(card), brief: text } });
      }
    }
    if (!m.brief) {
      save();
      writeFileSync(join(dir, "out/runner.json"), JSON.stringify({ code: 0, timedOut: false, tail: outFile(dir, "manager-brief.err").slice(-2000) }));
      return log(`${managerName(m.manager)} wrote no brief; Mike does not run`);
    }
    prompt += briefSection({ manager: m.manager, brief: m.brief, lastReason: manager.lastReason });
    m.events.push({ type: "sent_to_mike", at: new Date().toISOString(), data: { brief_version: m.brief.version, ...(manager.lastReason && { reason: manager.lastReason }) } });
    save();
  }

  // 2. Code: Mike works the card with the brief.
  writeFileSync(join(dir, "out/prompt.md"), prompt);
  const result = await inBox("work", { FACTORY_PROMPT: runner === "box" ? "/out/prompt.md" : join(dir, "out/prompt.md") });
  const timedOut = result.timedOut || timedOutExit(outFile(dir, "claude-exit").trim());
  writeFileSync(join(dir, "out/runner.json"), JSON.stringify({ code: result.code, timedOut, tail: result.output.slice(-2000) }));
  log(`${runner} exited ${result.code}${timedOut ? " (time cap)" : ""}`);

  // 3. Check: the manager, never Mike, judges the work against the brief. A
  // question is not work to check: it goes to Jessica (applyCheck, to_jessica).
  const report = outFile(dir, "report.md");
  if (m && !timedOut && report && parseReport(report).outcome !== "question") {
    const commits = Number(outFile(dir, "commit-count").trim()) || 0;
    writeFileSync(join(dir, "out/manager-check-prompt.md"), checkPrompt({ card, manager: m.manager, roleFile: repoFile(`agents/factory/managers/${m.manager}.md`), brief: m.brief, report, commits }));
    const ran = await inBox("manager", { FACTORY_MANAGER_STEP: "check" });
    m.verdict = parseVerdict(managerAnswer(dir, "check", ran));
    log(`${managerName(m.manager)}'s check: ${m.verdict ? `${m.verdict.verdict}: ${m.verdict.reason}` : "unreadable"}`);
    save();
  }
}

// Typecheck and tests of dashboard/ on the PR branch, in a throwaway worktree.
function dashboardGate(dir, branch) {
  const tree = join(dir, "gate");
  git("worktree", "add", "-q", "--force", tree, branch);
  try {
    for (const [cmd, args] of [["npm", ["ci", "--no-audit", "--no-fund"]], ["npx", ["tsc", "--noEmit"]], ["npm", ["test"]]]) {
      const r = run(cmd, args, { cwd: join(tree, "dashboard"), allowFail: true });
      if (r.status !== 0) return { ok: false, tail: `${cmd} ${args[0]}: ${(r.stdout + r.stderr).trim().slice(-300)}` };
    }
    return { ok: true };
  } finally {
    git("worktree", "remove", "--force", tree);
  }
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
    const doctor = card.source === "factory";
    const evidence = listFiles(join(dir, "out/evidence"));
    let d = decide({ report, commits, files, timedOut: ran.timedOut, boxExit: ran.code ?? -1, doctor, evidence, automerge: AUTOMERGE });
    if (ran.code === null) d.notes = "The agent step never finished (cancelled or crashed). " + d.notes;
    if (!report) d.notes += ` Last output: ${(outFile(dir, "agent.err") || ran.tail).trim().slice(-500)}`;
    // The manager's check decides, not Mike's own outcome: sent back reopens
    // the card with no PR, to-jessica keeps a draft for a person, only passed
    // keeps the free lane.
    const manager = existsSync(join(dir, "out/manager.json")) ? readJson(join(dir, "out/manager.json")) : null;
    const checked = applyCheck(d, manager);
    d = checked.decision;
    const check = checkLine(manager, d);
    if (manager) await logEvents(card, manager.manager, runRow.id, [...manager.events, ...checked.events]);
    if (doctor) d = parkIfSpent(d, card.runs.length + 1);
    const usage = agentUsage(outFile(dir, "agent.jsonl"));
    if (usage) log(`agent cost $${usage.costUsd}, ${usage.turns} turns, ${usage.stop}`);

    let pr_url = null;
    let mergedAt = null;
    if (d.openPr) {
      // Over PR_LINE_LIMIT lines, the agent's commits are split at a commit
      // boundary into two stacked draft PRs; neither merges itself.
      const commitLines = git("rev-list", "--reverse", `refs/factory/base..${branch}`).split("\n").filter(Boolean)
        .map((c) => changedLines(parseNumstat(git("diff", "--numstat", `${c}^`, c))));
      const cut = splitPoint(commitLines);
      if (cut) d = { ...d, merge: false, notes: `${d.notes} Over ${PR_LINE_LIMIT} lines, opened as two PRs.` };
      else if (changedLines(parseNumstat(git("diff", "--numstat", `refs/factory/base...${branch}`))) > PR_LINE_LIMIT) d = { ...d, merge: false };
      const opened = [];
      const openPr = ({ head, base, from, to, part }) => {
        git("push", "-q", "origin", `${to}:refs/heads/${head}`);
        const bodyFile = join(dir, `pr-body-${opened.length}.md`);
        const body = (graph) => prBody({ card, report, decision: d, run: runRow, runUrl: actionsRunUrl(process.env), evidence, graph, part, check });
        writeFileSync(bodyFile, body(""));
        const url = run("gh", ["pr", "create", ...(d.merge ? [] : ["--draft"]), "--base", base, "--head", head, "--title", `${prTitle(card)}${part ? ` (${opened.length + 1}/2)` : ""}`, "--body-file", bodyFile], { cwd: REPO }).stdout.trim().split("\n").at(-1);
        // The graph links each box to the file's diff, so it needs the PR's URL.
        const stats = parseNumstat(git("diff", "--numstat", `${from}...${to}`));
        writeFileSync(bodyFile, body(changeGraph(stats, (f) => diffAnchor(url, f, (s) => createHash("sha256").update(s).digest("hex")))));
        run("gh", ["pr", "edit", url, "--body-file", bodyFile], { cwd: REPO, allowFail: true });
        opened.push(url);
        log(`${d.merge ? "ready" : "draft"} PR ${url}`);
        return url;
      };
      if (cut) {
        const mid = git("rev-list", "--reverse", `refs/factory/base..${branch}`).split("\n")[cut - 1];
        const first = openPr({ head: `${branch}-part1`, base: BASE, from: "refs/factory/base", to: mid, part: "**Part 1 of 2.** Part 2 builds on this branch." });
        openPr({ head: branch, base: `${branch}-part1`, from: mid, to: `refs/heads/${branch}`, part: `**Part 2 of 2.** Merge part 1 first: ${first}` });
        d = { ...d, notes: `${d.notes} Part 2: ${opened[1]}` };
      } else {
        openPr({ head: branch, base: BASE, from: "refs/factory/base", to: `refs/heads/${branch}` });
      }
      pr_url = opened[0];
    }
    if (d.merge) {
      // A PR opened with the workflow token starts no CI, so the free lane runs
      // the dashboard's checks itself and merges only on green. Anything that
      // fails leaves the PR open and the card in-progress for a person.
      const gate = dashboardGate(dir, branch);
      const m = gate.ok ? run("gh", ["pr", "merge", pr_url, "--squash", "--delete-branch"], { cwd: REPO, allowFail: true }) : null;
      if (m?.status === 0) {
        log("free lane: checks green, merged");
        mergedAt = new Date().toISOString();
        // The workflow token's merge starts no push workflow either, so hand
        // the merge to factory-after-merge (verify map, owner memory) directly.
        const sha = run("gh", ["pr", "view", pr_url, "--json", "mergeCommit", "--jq", ".mergeCommit.oid"], { cwd: REPO, allowFail: true }).stdout.trim();
        const r = sha && run("gh", ["workflow", "run", "factory-after-merge.yml", "-f", `sha=${sha}`, "-f", `base=${BASE}`], { cwd: REPO, allowFail: true });
        log(r?.status === 0 ? `after-merge dispatched for ${sha.slice(0, 8)}` : "after-merge not dispatched");
      } else {
        const why = gate.ok ? `the merge was refused: ${(m.stderr || m.stdout || "").trim().slice(0, 300)}` : `the dashboard checks failed: ${gate.tail}`;
        d = { ...d, cardStatus: "in-progress", notes: `${d.notes} Not merged, ${why}` };
      }
    }
    let cardExtra = {};
    if (d.question) ({ d, cardExtra } = askOwner(dir, card, runRow, d, pr_url));
    await closeRun(runRow.id, card.id, d, { pr_url, branch: d.openPr ? branch : null }, mergedAt, cardExtra);
    log(`outcome ${d.outcome}, card ${d.cardStatus}: ${d.notes.slice(0, 300)}`);
    output("pr_url", pr_url ?? "");
    if (!doctor && moveGoodTag({ executorRef: process.env.EXECUTOR_REF, outcome: d.outcome, commits })) {
      // The doctor checks the executor out from this tag. A failed move only logs.
      const r = run("git", ["-C", REPO, "push", "-f", "origin", `HEAD:refs/tags/${GOOD_TAG}`], { allowFail: true });
      log(r.status === 0 ? `${GOOD_TAG} moved to ${git("rev-parse", "HEAD")}` : `could not move ${GOOD_TAG}: ${(r.stderr || "").trim().slice(0, 300)}`);
    }
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
