import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAgents, renderRegistry, renderWorkerRegistry } from "./parse.mjs";

const dir = fileURLToPath(new URL(".", import.meta.url));
const out = fileURLToPath(new URL("../../dashboard/lib/agents/registry.generated.ts", import.meta.url));
const workerOut = fileURLToPath(new URL("../../ingest-worker/src/agents.generated.ts", import.meta.url));
const agents = loadAgents(dir);
writeFileSync(out, renderRegistry(agents));
writeFileSync(workerOut, renderWorkerRegistry(agents));
console.log(`wrote ${agents.length} agents to dashboard/lib/agents/registry.generated.ts and ingest-worker/src/agents.generated.ts`);
