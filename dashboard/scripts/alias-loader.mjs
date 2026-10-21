// Minimal ESM resolve hook that teaches plain `node` the `@/*` tsconfig path
// alias the dashboard uses everywhere.
//
// WHY: scripts/verify-operator.mjs wants to run the REAL lib/cxAttention.ts
// against the real database, not a re-implementation of it — otherwise the
// check proves only that the script agrees with itself. cxAttention.ts reaches
// its dependencies through `@/lib/...`, which Next resolves at build time and
// plain node does not resolve at all (see scripts/tests.mjs's EXCLUDED note on
// lib/apiAuth.ts for the same problem in the test runner).
//
// Node 24 strips TypeScript types on its own, so once the alias resolves the
// modules load as-is. Deliberately not wired into the test runner: this exists
// for the one-off verification script, and lib/cxAttentionRules.ts remains the
// import-free half that tests are meant to target.
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);

const EXTS = ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts"];

/** First of `base + ext` that exists on disk, or null. */
function firstExisting(base) {
  for (const ext of EXTS) {
    const candidate = new URL(base + ext);
    if (existsSync(candidate)) return candidate.href;
  }
  return null;
}

export function resolve(specifier, context, nextResolve) {
  // `@/lib/foo` → <dashboard>/lib/foo.ts
  if (specifier.startsWith("@/")) {
    const hit = firstExisting(new URL(specifier.slice(2), ROOT).href);
    if (hit) return { url: hit, shortCircuit: true };
    return nextResolve(pathToFileURL(new URL(specifier.slice(2), ROOT).pathname).href, context);
  }
  // TypeScript sources also import each other extensionlessly (`./cxAttentionRules`),
  // which ESM does not do either — resolve those relative to the importing file.
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
    const hit = firstExisting(new URL(specifier, context.parentURL).href);
    if (hit) return { url: hit, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
