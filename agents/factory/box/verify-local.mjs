// Points the verify skill (.claude/skills/verify/control.mjs) at the local
// garden's database instead of the side project's pooler, without editing
// .claude/ (factory agents may not, see agent-settings.json).
//
//   NODE_OPTIONS="--import file:///.../agents/factory/box/verify-local.mjs"
//
// Only the `pg` that control.mjs imports is swapped, and only when
// VERIFY_DATABASE_URL is set (local-garden.sh writes it to dashboard/.env.local,
// which control.mjs loads). Everything else resolves as usual.
import { createRequire, register } from "node:module";
import { isMainThread } from "node:worker_threads";

const VERIFY_DIR = "/.claude/skills/verify/";

// Loader hook (runs on the hooks thread).
export async function resolve(specifier, context, next) {
  if (specifier === "pg" && context.parentURL?.includes(VERIFY_DIR)) {
    return { url: `${import.meta.url}?pg-from=${encodeURIComponent(context.parentURL)}`, shortCircuit: true };
  }
  return next(specifier, context);
}

const from = new URL(import.meta.url).searchParams.get("pg-from");
let shim = null;
if (from) {
  // This file loaded as control.mjs's `pg`: the real one, with Client redirected.
  const real = createRequire(from)("pg");
  class Client extends real.Client {
    constructor(cfg) {
      const url = process.env.VERIFY_DATABASE_URL;
      super(url ? { connectionString: url, query_timeout: cfg?.query_timeout } : cfg);
    }
  }
  shim = { ...real, Client };
} else if (isMainThread) {
  register(import.meta.url);
}
export default shim;
