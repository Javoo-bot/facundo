// Copy the canonical matcher to the ingest worker, byte for byte.
//
//   lib/match.ts  ──►  ../ingest-worker/src/match.ts
//
// The worker and the dashboard are separate builds that cannot import from each
// other, so the matcher has to exist twice. It used to be two hand-maintained
// files "kept in step" by convention plus a couple of regex assertions — and it
// drifted three ways anyway (the performance term, the capacity filter, and the
// null-radius/null-tier guards were all missing from the dashboard copy) without
// the regexes noticing. A dashboard re-match and the worker's automatic match
// were ranking florists differently, silently.
//
// So: one file is canonical, the other is generated, and lib/match.test.mjs
// asserts byte equality. Drift becomes impossible rather than approximated.
//
// Run after ANY edit to lib/match.ts:  npm run sync:match
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../lib/match.ts", import.meta.url));
const TARGET = fileURLToPath(new URL("../../ingest-worker/src/match.ts", import.meta.url));

const source = readFileSync(SOURCE, "utf8");
const current = (() => {
  try {
    return readFileSync(TARGET, "utf8");
  } catch {
    return null;
  }
})();

if (current === source) {
  console.log("match.ts already in sync — nothing to do.");
} else {
  writeFileSync(TARGET, source);
  console.log(`Synced lib/match.ts -> ingest-worker/src/match.ts (${source.length} bytes).`);
}
