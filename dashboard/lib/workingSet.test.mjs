import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isGateActive, isInWorkingSet, parseOrderNames, WORKING_SET_TERMINAL } from "./workingSet.ts";

const picked = { tags: null, worklist_at: "2026-08-11T10:00:00Z" };
const tagged = { tags: "10 August 2026, fulfill dominik, new-customer", worklist_at: null };
const plain = { tags: "10 August 2026, new-customer", worklist_at: null };
const bare = { tags: null, worklist_at: null };

// ---------------------------------------------------------------------------
// The semantics table from the design doc, one test per row. The last two rows
// are the load-bearing ones — they are the reason this helper exists rather
// than a second call to hasActiveTag.
// ---------------------------------------------------------------------------

test("row 1 — no tags, no picks: the gate is OFF and every order passes", () => {
  const cfg = { activeTags: [], anyExplicitPicks: false };
  assert.equal(isGateActive(cfg), false);
  for (const o of [picked, tagged, plain, bare]) {
    assert.equal(isInWorkingSet(o, cfg), true);
  }
});

test("row 2 — tags, no picks: tag matches only (unchanged tag-gate behavior)", () => {
  const cfg = { activeTags: ["fulfill dominik"], anyExplicitPicks: false };
  assert.equal(isGateActive(cfg), true);
  assert.equal(isInWorkingSet(tagged, cfg), true);
  assert.equal(isInWorkingSet(plain, cfg), false);
  assert.equal(isInWorkingSet(bare, cfg), false);
});

test("row 3 — tags AND picks: the UNION, not the intersection", () => {
  const cfg = { activeTags: ["fulfill dominik"], anyExplicitPicks: true };
  assert.equal(isInWorkingSet(tagged, cfg), true, "tag match still passes");
  assert.equal(isInWorkingSet(picked, cfg), true, "an explicit pick passes even with no matching tag");
  assert.equal(isInWorkingSet(plain, cfg), false, "neither tagged nor picked stays out");
});

test("row 4 — no tags but picks exist: ONLY the picks", () => {
  const cfg = { activeTags: [], anyExplicitPicks: true };
  assert.equal(isGateActive(cfg), true, "picks alone turn the gate on");
  assert.equal(isInWorkingSet(picked, cfg), true);
  // The whole point: an empty tag set must NOT fall back to "match everything"
  // here, or the explicit list would be a no-op in exactly the mode staff want
  // it most. hasActiveTag(_, []) is true, so isInWorkingSet cannot delegate.
  assert.equal(isInWorkingSet(tagged, cfg), false);
  assert.equal(isInWorkingSet(plain, cfg), false);
  assert.equal(isInWorkingSet(bare, cfg), false);
});

test("whitespace-only tags are not a gate (same as hasActiveTag)", () => {
  const cfg = { activeTags: ["  ", ""], anyExplicitPicks: false };
  assert.equal(isGateActive(cfg), false);
  assert.equal(isInWorkingSet(plain, cfg), true);
});

test("a pick passes regardless of tags, casing, or a null tag string", () => {
  const cfg = { activeTags: ["priority"], anyExplicitPicks: true };
  assert.equal(isInWorkingSet({ tags: null, worklist_at: "2026-08-11T00:00:00Z" }, cfg), true);
  assert.equal(isInWorkingSet({ tags: "", worklist_at: "2026-08-11T00:00:00Z" }, cfg), true);
});

test("tag matching stays case-insensitive and trimmed through the union path", () => {
  const cfg = { activeTags: ["FULFILL Dominik"], anyExplicitPicks: true };
  assert.equal(isInWorkingSet({ tags: "fulfill dominik ,x", worklist_at: null }, cfg), true);
});

// ---------------------------------------------------------------------------
// parseOrderNames — what staff paste into the Settings box.
// ---------------------------------------------------------------------------

test("parseOrderNames accepts commas, newlines, spaces, and an optional #", () => {
  assert.deepEqual(parseOrderNames("#2000018, #2000026"), ["#2000018", "#2000026"]);
  assert.deepEqual(parseOrderNames("2000018\n2000026"), ["#2000018", "#2000026"]);
  assert.deepEqual(parseOrderNames("  #2000018   2000026 "), ["#2000018", "#2000026"]);
  assert.deepEqual(parseOrderNames("#2000018; 2000026"), ["#2000018", "#2000026"]);
});

test("parseOrderNames dedupes, preserves input order, and drops non-numbers", () => {
  assert.deepEqual(parseOrderNames("#2000018, 2000018, ##2000018"), ["#2000018"]);
  assert.deepEqual(parseOrderNames("abc, #2000018, --, #"), ["#2000018"]);
  assert.deepEqual(parseOrderNames(""), []);
  assert.deepEqual(parseOrderNames("   "), []);
});

test("WORKING_SET_TERMINAL matches the orders list's terminal set", () => {
  // Mirrors TERMINAL_COMPLETED in app/(staff)/orders/page.tsx. If that list
  // changes, an order could finish and never be auto-dropped from the set.
  const page = readFileSync(new URL("../app/(staff)/orders/page.tsx", import.meta.url), "utf8");
  const m = page.match(/const TERMINAL_COMPLETED = \[([^\]]+)\]/);
  assert.ok(m, "TERMINAL_COMPLETED not found in the orders page");
  const fromPage = m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
  assert.deepEqual([...WORKING_SET_TERMINAL].sort(), fromPage.sort());
});

// ---------------------------------------------------------------------------
// The mirrored-helper trap: dashboard/lib/workingSet.ts and
// ingest-worker/src/workingSet.ts are deliberately duplicated across two builds.
// If they drift, the worker operates on a different set of orders than the
// dashboard shows — silently. Compare the CODE, ignoring comments, blank lines
// and the one import specifier that legitimately differs (./orderTags vs ./tags).
// ---------------------------------------------------------------------------

function codeOnly(src) {
  return src
    .replace(/\r/g, "") // CRLF checkout: `\r` is a line terminator, so `//.*$`
                        // below can't match past it and every line comment
                        // survived — the two files then differ only in their
                        // (legitimately different) headers and this guard cried
                        // drift on every Windows run.
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").trimEnd())
    .filter((l) => l.trim().length > 0)
    .join("\n")
    .replace(/from "\.\/(orderTags|tags)(\.ts)?"/g, 'from "./TAGS"');
}

test("the worker's mirrored copy has not drifted", () => {
  const here = readFileSync(new URL("./workingSet.ts", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../../ingest-worker/src/workingSet.ts", import.meta.url), "utf8");
  assert.equal(
    codeOnly(worker),
    codeOnly(here),
    "ingest-worker/src/workingSet.ts has drifted from dashboard/lib/workingSet.ts — mirror the change"
  );
});
