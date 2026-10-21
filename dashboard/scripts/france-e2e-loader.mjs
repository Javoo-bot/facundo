// Loader for scripts/france-e2e.mjs.
//
// Registers the shared `@/*` alias hook (scripts/alias-loader.mjs) AND stubs
// `server-only`, which the matcher chain needs and plain node cannot resolve.
//
// WHY A SECOND LOADER rather than teaching alias-loader.mjs about it: that hook
// is shared with check-control-panel.mjs / verify-operator.mjs, whose modules do
// not import `server-only`. Silently satisfying a guard import for every script
// would weaken it everywhere to serve one caller.
//
// `server-only` is a build-time guard — a package whose only job is to fail the
// Next build if a module reaches the client bundle. There is no runtime
// behaviour to reproduce, so an empty module is a faithful stub, not a mock.
// lib/candidateRefill.ts, lib/matchConfig.ts and lib/rematch.ts are the real
// modules either way; only the guard is elided.
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);
register(
  "data:text/javascript," +
    encodeURIComponent(`
      export function resolve(specifier, context, nextResolve) {
        if (specifier === "server-only") {
          return { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true };
        }
        return nextResolve(specifier, context);
      }
    `),
  import.meta.url
);
