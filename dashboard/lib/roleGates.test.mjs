import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// ---- every non-admin role gate must also admit admin ----
//
// `requireRole` (lib/apiAuth.ts) is EXACT MEMBERSHIP, not a hierarchy:
//
//     if (!role || !roles.includes(role)) return 403 "Your role doesn't allow this."
//
// So `requireRole("ops")` refuses an admin. Three routes did exactly that —
// including the CX reply route, where an admin pressing "Send reply" on an
// escalated thread got "Your role doesn't allow this" and no reply went out.
// Thirty other call sites spell out ("ops", "admin"); those three had simply
// been written without it, and nothing caught the difference.
//
// This is a source scan rather than a unit test because lib/apiAuth.ts resolves
// `@/lib/supabase` through a tsconfig path alias, which plain `node --test`
// cannot follow — the reason lib/apiAuth.test.mjs sits in scripts/tests.mjs's
// EXCLUDED list. The text of the call is enough to check the invariant.
//
// The rule: a gate naming any non-admin role must name "admin" too. A gate that
// is admin-only (`requireRole("admin")`) is the intended way to say "admins
// only" and is left alone.

const ROOT = "app";

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const file = path.join(dir, entry);
    if (statSync(file).isDirectory()) sourceFiles(file, out);
    else if (/\.tsx?$/.test(file) && !/\.test\./.test(file)) out.push(file);
  }
  return out;
}

/** Every `requireRole(...)` call in `src`, as its list of role literals. */
function roleGates(src) {
  return Array.from(src.matchAll(/requireRole\(([^)]*)\)/g)).map((m) => ({
    raw: m[0],
    roles: Array.from(m[1].matchAll(/"([a-z_]+)"/g), (r) => r[1]),
  }));
}

test("no route gate locks an admin out", () => {
  const offences = [];
  for (const file of sourceFiles(ROOT)) {
    const src = readFileSync(file, "utf8");
    for (const gate of roleGates(src)) {
      if (gate.roles.length === 0) continue; // dynamic call, nothing to read
      if (gate.roles.includes("admin")) continue;
      offences.push(`${file}: ${gate.raw}`);
    }
  }
  assert.deepEqual(
    offences,
    [],
    `requireRole is exact membership, so these refuse an admin:\n${offences.join("\n")}`
  );
});

test("the scan reads the role list the way requireRole does", () => {
  const gates = roleGates(`
    const a = await requireRole("ops");
    const b = await requireRole("ops", "admin");
    const c = await requireRole("finance","admin");
    const d = await requireRole("admin");
  `);
  assert.deepEqual(gates.map((g) => g.roles), [["ops"], ["ops", "admin"], ["finance", "admin"], ["admin"]]);
  // Only the first would 403 an admin.
  assert.deepEqual(gates.filter((g) => !g.roles.includes("admin")).map((g) => g.roles), [["ops"]]);
});
