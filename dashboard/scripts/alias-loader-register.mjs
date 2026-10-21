// Registers the `@/*` resolve hook (scripts/alias-loader.mjs) for a script run
// with `node --import ./scripts/alias-loader-register.mjs …`.
import { register } from "node:module";
register("./alias-loader.mjs", import.meta.url);
