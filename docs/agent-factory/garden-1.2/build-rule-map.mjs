// Rebuilds rule-map.html from the real rules, so the page never drifts from
// dashboard/lib/lifecycle.ts. Run from the repo root:
//   node docs/agent-factory/garden-1.2/build-rule-map.mjs
// Inputs: lifecycle.ts (situations), general-rules.json (grouping),
// agents/factory/cards.mjs (which situations an agent owns today).

import { readFileSync, writeFileSync, copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");

// lifecycle.ts has no imports; a .mts copy loads with Node's type stripping.
const tmp = join(mkdtempSync(join(tmpdir(), "rule-map-")), "lifecycle.mts");
copyFileSync(join(repo, "dashboard/lib/lifecycle.ts"), tmp);
const { PHASES, CROSS_CUTTING } = await import(pathToFileURL(tmp).href);

const pick = (b) => ({ id: b.id, trigger: b.trigger, handling: b.handling, status: b.status, milestone: b.milestone });
const data = {
  phases: PHASES.map((p) => ({ id: p.id, label: p.label, stages: p.stages.map((s) => ({
    id: s.id, label: s.label, short: s.short, status: s.status, branches: (s.branches ?? []).map(pick) })) })),
  cross: CROSS_CUTTING.map(pick),
};

const groups = JSON.parse(readFileSync(join(here, "general-rules.json"), "utf8"));
const cards = readFileSync(join(repo, "agents/factory/cards.mjs"), "utf8");
const owners = Function(`return ${cards.match(/LIFECYCLE_OWNER = (\{[\s\S]*?\});/)[1]}`)();

// Every situation must sit under exactly one general rule.
const ids = [...data.phases.flatMap((p) => p.stages.flatMap((s) => s.branches)), ...data.cross].map((b) => b.id);
const seen = groups.flatMap((g) => g.members);
const missing = ids.filter((id) => !seen.includes(id));
const unknown = seen.filter((id) => !ids.includes(id));
const dupes = seen.filter((id, i) => seen.indexOf(id) !== i);
if (missing.length || unknown.length || dupes.length) {
  console.error({ missing, unknown, dupes });
  throw new Error("general-rules.json is out of step with lifecycle.ts");
}

const safe = (s) => s.replace(/<\//g, "<\\/");
const page = readFileSync(join(here, "rule-map.template.html"), "utf8")
  .replace("__DATA__", () => safe(JSON.stringify(data)))
  .replace("__OWNERS__", () => JSON.stringify(owners))
  .replace("__GROUPS__", () => safe(JSON.stringify(groups)));
writeFileSync(join(here, "rule-map.html"), page);
console.log(`rule-map.html: ${ids.length} situations, ${groups.length} general rules`);
