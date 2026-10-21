// Find every test file and run it. Replaces the hand-maintained list that used
// to live in package.json's `test` script.
//
// WHY THIS EXISTS. That list had grown to 71 entries on one line, which meant:
//
//   1. Every PR adding a test edited the SAME line, so two concurrent PRs
//      always conflicted there — and a squash-merge resolution silently kept
//      one side. That is exactly how lib/lineItemKind.test.mjs came to exist on
//      main with its 9 tests never running.
//   2. Forgetting to add a file was invisible. An audit found THIRTEEN test
//      files that had never run once, including eight covering Airwallex card
//      controls, funds movement and webhook signature verification.
//
// Discovery removes both failure modes: a new `*.test.mjs` runs the moment it
// exists, and nothing has to be edited to make that happen.

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

/** Directories never worth walking. */
const SKIP_DIRS = new Set(["node_modules", ".next", ".open-next", ".open-next.nosync", ".git", "coverage"]);

/**
 * Test files that CANNOT run under plain `node --test`, with the reason.
 *
 * Keep this list tiny and justified. It is the one manual thing left here, so
 * an entry must say why — and the runner fails if an entry no longer exists,
 * so the list cannot quietly rot the way the old inclusion list did.
 */
const EXCLUDED = new Map([
  [
    "lib/apiAuth.test.mjs",
    "imports lib/apiAuth.ts, which resolves '@/lib/supabase' through the " +
      "tsconfig path alias. Plain `node --test` has no alias resolution, so the " +
      "import throws before any test runs. Runnable again if apiAuth.ts's " +
      "server-only deps are factored out behind relative imports, the way " +
      "lib/offerEmailContent.ts was.",
  ],
]);

async function findTests(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await findTests(full, out);
    } else if (entry.name.endsWith(".test.mjs")) {
      // Forward slashes regardless of OS, so the EXCLUDED keys (and the
      // `node --test` args) match on Windows as well as on CI's Linux.
      out.push(path.relative(process.cwd(), full).split(path.sep).join("/"));
    }
  }
  return out;
}

const all = (await findTests(process.cwd())).sort();

// A stale exclusion is a silent hole, so treat it as an error rather than
// letting the list drift away from reality.
const missing = [...EXCLUDED.keys()].filter((f) => !all.includes(f));
if (missing.length) {
  console.error(`Excluded test file(s) no longer exist — remove them from scripts/tests.mjs:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

const toRun = all.filter((f) => !EXCLUDED.has(f));
for (const [file, why] of EXCLUDED) console.log(`skipping ${file} — ${why.split(".")[0]}.`);
console.log(`running ${toRun.length} test files (${all.length} found)\n`);

spawn(process.execPath, ["--test", ...toRun], { stdio: "inherit" })
  .on("exit", (code) => process.exit(code ?? 1));
