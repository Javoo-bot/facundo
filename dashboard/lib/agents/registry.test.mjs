import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgents, renderRegistry, renderWorkerRegistry, rulesHash } from "../../../agents/thinking/parse.mjs";
import { AGENTS } from "./registry.generated.ts";
import { buildSupportPrompt } from "../cxAgent.ts";
import { GOLDEN_INPUT } from "./conciergeGoldenInput.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const thinkingDir = join(repo, "agents", "thinking");

// Files that carry the transport for an agent rather than being one.
const TRANSPORTS = ["ingest-worker/src/openrouter.ts", "ingest-worker/src/llm.ts"];
const LLM_CALL = /openrouter\.ai\/api\/v1|new GoogleGenAI|new Anthropic\(|from "\.\/llm"|personaliseRecruitingEmail\(/;

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [full] : [];
  });
}

test("registry.generated.ts matches agents/thinking/*.md (run: node agents/thinking/build.mjs)", () => {
  const onDisk = readFileSync(join(repo, "dashboard/lib/agents/registry.generated.ts"), "utf8");
  assert.equal(onDisk, renderRegistry(loadAgents(thinkingDir)));
});

test("ingest-worker/src/agents.generated.ts matches agents/thinking/*.md (run: node agents/thinking/build.mjs)", () => {
  const onDisk = readFileSync(join(repo, "ingest-worker/src/agents.generated.ts"), "utf8");
  assert.equal(onDisk, renderWorkerRegistry(loadAgents(thinkingDir)));
});

test("the rules hash changes when the rules or style change, and only then", () => {
  const concierge = AGENTS.find((a) => a.id === "concierge");
  assert.match(concierge.rulesHash, /^[0-9a-f]{16}$/);
  assert.equal(rulesHash(concierge), concierge.rulesHash);
  assert.notEqual(rulesHash({ ...concierge, rules: [...concierge.rules, "One more rule."] }), concierge.rulesHash);
  assert.notEqual(rulesHash({ ...concierge, style: "Shout." }), concierge.rulesHash);
  assert.equal(rulesHash({ ...concierge, nick: "Renamed" }), concierge.rulesHash);
});

test("every call site an agent file names exists", () => {
  for (const a of AGENTS) for (const p of a.callSites) assert.ok(existsSync(join(repo, p)), `${a.id}: ${p} does not exist`);
});

test("every file that calls a model belongs to an agent file in agents/thinking/", () => {
  const owned = new Set([...AGENTS.flatMap((a) => a.callSites), ...TRANSPORTS]);
  const roots = ["dashboard/lib", "dashboard/app", "ingest-worker/src"].map((r) => join(repo, r));
  const unowned = roots.flatMap(sourceFiles)
    .filter((f) => readFileSync(f, "utf8").split(/\r?\n/).some((l) => !l.trim().startsWith("//") && LLM_CALL.test(l)))
    .map((f) => relative(repo, f).replaceAll("\\", "/"))
    .filter((f) => !owned.has(f));
  assert.deepEqual(unowned, [], "a new AI call needs an agent file in agents/thinking/ that lists it under call_sites");
});

test("Concierge's prompt is built from concierge.md exactly as before the move", () => {
  const golden = readFileSync(new URL("./concierge.golden.txt", import.meta.url), "utf8");
  assert.equal(
    buildSupportPrompt(GOLDEN_INPUT),
    golden,
    "changed concierge.md on purpose? Re-run node dashboard/lib/agents/capture-concierge-golden.mjs so the prompt change shows in the diff",
  );
});
