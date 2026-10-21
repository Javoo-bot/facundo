import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

export const STAGES = ["off", "shadow", "draft", "auto"];
export const SYSTEMS = ["recruiting", "production", "staff"];
const REQUIRED = ["id", "nick", "emoji", "name", "system", "stage", "prompt_source", "model", "switch", "entry", "call_sites"];

function frontmatter(text, file) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) throw new Error(`${file}: no frontmatter`);
  const out = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) { out[listKey].push(item[1].trim()); continue; }
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!kv) throw new Error(`${file}: cannot read frontmatter line "${line}"`);
    if (kv[2] === "") { listKey = kv[1]; out[kv[1]] = []; } else { listKey = null; out[kv[1]] = kv[2].trim(); }
  }
  return { meta: out, body: text.slice(m[0].length) };
}

function sections(body) {
  const out = {};
  let current = null;
  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^## (.+)$/);
    if (h) { current = h[1].trim(); out[current] = []; continue; }
    if (current) out[current].push(line);
  }
  return out;
}

/** Names the version of an agent's rules and style, so a stored run or a trace
 * says which wording of agents/thinking/<id>.md produced it. */
export function rulesHash({ rules, style }) {
  return createHash("sha256").update(JSON.stringify({ rules, style })).digest("hex").slice(0, 16);
}

const paragraph = lines => (lines ?? []).map(l => l.trim()).filter(Boolean).join(" ");

export const GOOD_SECTION = "What good looks like";
const MEASURE_FIELDS = ["Means", "Data", "Minimum", "Window", "Kind", "Measurable"];

function parseMinimum(text, where) {
  const m = text.match(/^at (least|most) (\d+(?:\.\d+)?)(%?)$/);
  if (!m) throw new Error(`${where}: Minimum must read "at least 90%", "at most 5%" or "at least 0.7", not "${text}"`);
  const value = m[3] ? Number(m[2]) / 100 : Number(m[2]);
  return { op: m[1] === "least" ? ">=" : "<=", value, percent: m[3] === "%", text };
}

function parseWindow(text, where) {
  const m = text.match(/^rolling (\d+) days?, at least (\d+) cases?$/);
  if (!m) throw new Error(`${where}: Window must read "rolling 2 days, at least 20 cases", not "${text}"`);
  return { days: Number(m[1]), minCases: Number(m[2]), text };
}

/** The "## What good looks like" section: one "### <measure-id>" block per
 * measure, each with the six "- Field: value" lines in MEASURE_FIELDS. Never
 * part of the prompt; the factory reads it to know when an agent is below its
 * minimum (agents/factory/thresholds.mjs). */
export function parseGood(lines, file) {
  const measures = [];
  let current = null;
  for (const raw of lines ?? []) {
    const line = raw.trim();
    const h = line.match(/^### ([a-z0-9-]+)$/);
    if (h) { current = { id: h[1], fields: {} }; measures.push(current); continue; }
    if (line.startsWith("### ")) throw new Error(`${file}: measure id must be lowercase-with-dashes: "${line}"`);
    const f = line.match(/^- ([A-Za-z]+): (.+)$/);
    if (f && current && MEASURE_FIELDS.includes(f[1])) { current.fields[f[1]] = f[2].trim(); continue; }
    if (f && current) throw new Error(`${file}: measure "${current.id}" has unknown field "${f[1]}"`);
    if (line && current) throw new Error(`${file}: measure "${current.id}" has a line that is not "- Field: value": "${line}"`);
  }
  if (measures.length === 0 || measures.length > 3) throw new Error(`${file}: ## ${GOOD_SECTION} needs 1 to 3 measures, found ${measures.length}`);
  return measures.map(({ id, fields }) => {
    const where = `${file} measure "${id}"`;
    for (const k of MEASURE_FIELDS) if (!fields[k]) throw new Error(`${where}: missing "- ${k}:"`);
    if (!["decides", "advice"].includes(fields.Kind)) throw new Error(`${where}: Kind must be decides or advice`);
    const minimum = parseMinimum(fields.Minimum, where);
    if (fields.Kind === "decides" && !minimum.percent) throw new Error(`${where}: a measure that decides is a share of cases, so its Minimum is a percentage`);
    const now = fields.Measurable.match(/^now\b/);
    const notYet = fields.Measurable.match(/^not measurable yet: (.+)$/);
    if (!now && !notYet) throw new Error(`${where}: Measurable must start with "now" or "not measurable yet: needs ..."`);
    return {
      id, means: fields.Means, data: fields.Data, minimum, window: parseWindow(fields.Window, where),
      kind: fields.Kind, measurableNow: Boolean(now), measurable: fields.Measurable,
    };
  });
}

export function parseAgent(file) {
  const text = readFileSync(file, "utf8").replace(/^﻿/, "");
  const { meta, body } = frontmatter(text, file);
  for (const k of REQUIRED) if (meta[k] === undefined) throw new Error(`${file}: missing "${k}"`);
  if (meta.id !== basename(file, ".md")) throw new Error(`${file}: id "${meta.id}" must match the file name`);
  if (!STAGES.includes(meta.stage)) throw new Error(`${file}: stage must be one of ${STAGES.join(", ")}`);
  if (!SYSTEMS.includes(meta.system)) throw new Error(`${file}: system must be one of ${SYSTEMS.join(", ")}`);
  if (!["file", "code"].includes(meta.prompt_source)) throw new Error(`${file}: prompt_source must be file or code`);
  const s = sections(body);
  const rules = (s.Rules ?? []).filter(l => l.startsWith("- ")).map(l => l.slice(2).trim());
  if (meta.prompt_source === "file" && rules.length === 0) throw new Error(`${file}: prompt_source is file but ## Rules has no "- " lines`);
  const spec = {
    id: meta.id, nick: meta.nick, emoji: meta.emoji, name: meta.name,
    system: meta.system, stage: meta.stage, promptSource: meta.prompt_source,
    model: meta.model, switch: meta.switch, entry: meta.entry, callSites: meta.call_sites,
    job: paragraph(s.Job), rules: meta.prompt_source === "file" ? rules : [], style: paragraph(s.Style),
  };
  if (!s[GOOD_SECTION]) throw new Error(`${file}: missing "## ${GOOD_SECTION}"`);
  return { ...spec, rulesHash: rulesHash(spec), good: parseGood(s[GOOD_SECTION], file) };
}

export function loadAgents(dir) {
  return readdirSync(dir).filter(f => f.endsWith(".md") && f !== "README.md").sort()
    .map(f => parseAgent(join(dir, f)));
}

/** The ingest worker is a separate build and cannot import the dashboard, so it
 * gets its own copy of what a trace needs, for the agents that run in it. */
export function renderWorkerRegistry(agents) {
  const worker = agents
    .filter((a) => a.callSites.some((p) => p.startsWith("ingest-worker/")))
    .map(({ id, nick, name, stage, rulesHash }) => ({ id, nick, name, stage, rulesHash }));
  return [
    "// Generated by agents/thinking/build.mjs from agents/thinking/*.md. Do not edit;",
    "// edit the agent's file and run `node agents/thinking/build.mjs`.",
    "",
    "export interface WorkerAgent {",
    "  id: string;",
    "  nick: string;",
    "  name: string;",
    "  stage: string;",
    "  rulesHash: string;",
    "}",
    "",
    `export const WORKER_AGENTS = ${JSON.stringify(Object.fromEntries(worker.map((a) => [a.id, a])), null, 2)} as const satisfies Record<string, WorkerAgent>;`,
    "",
    "export type WorkerAgentId = keyof typeof WORKER_AGENTS;",
    "",
  ].join("\n");
}

export function renderRegistry(agents) {
  return [
    "// Generated by agents/thinking/build.mjs from agents/thinking/*.md. Do not edit;",
    "// edit the agent's file and run `node agents/thinking/build.mjs`.",
    "",
    'export type AgentStage = "off" | "shadow" | "draft" | "auto";',
    'export type AgentSystem = "recruiting" | "production" | "staff";',
    `export type AgentId = ${agents.map((a) => JSON.stringify(a.id)).join(" | ")};`,
    "",
    "export interface AgentSpec {",
    "  id: AgentId;",
    "  nick: string;",
    "  emoji: string;",
    "  name: string;",
    "  system: AgentSystem;",
    "  stage: AgentStage;",
    '  promptSource: "file" | "code";',
    "  model: string;",
    "  switch: string;",
    "  entry: string;",
    "  callSites: readonly string[];",
    "  job: string;",
    "  rules: readonly string[];",
    "  style: string;",
    "  rulesHash: string;",
    "  good: readonly GoodMeasure[];",
    "}",
    "",
    "/** One line of an agent's \"What good looks like\": read by the factory, never by the prompt. */",
    "export interface GoodMeasure {",
    "  id: string;",
    "  means: string;",
    "  data: string;",
    '  minimum: { op: ">=" | "<="; value: number; percent: boolean; text: string };',
    "  window: { days: number; minCases: number; text: string };",
    '  kind: "decides" | "advice";',
    "  measurableNow: boolean;",
    "  measurable: string;",
    "}",
    "",
    `export const AGENTS: readonly AgentSpec[] = ${JSON.stringify(agents, null, 2)};`,
    "",
    "export function agentSpec(id: AgentId): AgentSpec {",
    "  const spec = AGENTS.find((a) => a.id === id);",
    "  if (!spec) throw new Error(`unknown agent ${id}`);",
    "  return spec;",
    "}",
    "",
  ].join("\n");
}
