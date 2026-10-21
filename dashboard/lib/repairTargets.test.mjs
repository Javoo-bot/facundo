import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REPAIR_FAILURE_PATTERNS, UNCHECKED_NOTES_PREFIX, repairNotesFilter } from "./repairTargets.ts";

test("the failure patterns match the worker's, exactly", () => {
  // The dashboard COUNTS the population the worker REPAIRS. If the two
  // predicates drift, the buttons promise a number no job will deliver — and
  // "Repair all" silently skips cities that do have work.
  const worker = readFileSync(
    new URL("../../ingest-worker/src/repair.ts", import.meta.url),
    "utf8"
  );
  const match = worker.match(
    /export const REPAIR_FAILURE_PATTERNS = \[([^\]]*)\] as const;/
  );
  assert.ok(match, "could not find REPAIR_FAILURE_PATTERNS in ingest-worker/src/repair.ts");
  const workerPatterns = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...REPAIR_FAILURE_PATTERNS], workerPatterns);
});

test("the free-layer 'Unchecked' prefix matches the worker's, exactly", () => {
  const worker = readFileSync(
    new URL("../../ingest-worker/src/repair.ts", import.meta.url),
    "utf8"
  );
  const match = worker.match(/export const UNCHECKED_NOTES_PREFIX = "([^"]+)";/);
  assert.ok(match, "could not find UNCHECKED_NOTES_PREFIX in ingest-worker/src/repair.ts");
  assert.equal(UNCHECKED_NOTES_PREFIX, match[1]);
});

test("the PostgREST filter ORs every pattern, the free-layer placeholder and the never-enriched case", () => {
  assert.equal(
    repairNotesFilter(),
    "enrichment_notes.is.null,enrichment_notes.ilike.unchecked*,enrichment_notes.ilike.*failed*,enrichment_notes.ilike.*unreachable*,enrichment_notes.ilike.*time budget*"
  );
});

test("the filter matches the worker's, string for string", () => {
  // Both sides build the filter the same way; pin the WHOLE string, not just
  // the patterns. The first version of this test compared only
  // REPAIR_FAILURE_PATTERNS, which is exactly why a missing `is.null` clause
  // could ship on both sides and still look "in lockstep".
  const worker = readFileSync(
    new URL("../../ingest-worker/src/repair.ts", import.meta.url),
    "utf8"
  );
  assert.match(worker, /"enrichment_notes\.is\.null",/,
    "worker filter must include the never-enriched (NULL notes) case");
  assert.match(worker, /enrichment_notes\.ilike\.\$\{UNCHECKED_NOTES_PREFIX\}\*/,
    "worker filter must include the free-layer 'Unchecked' placeholder case");
});

test("the filter is not keyed on any vendor's error text", () => {
  // The 2026-08-06 outage said "credit balance is too low"; the next one will
  // say something else, and the same buttons have to find it.
  const filter = repairNotesFilter().toLowerCase();
  for (const vendor of ["anthropic", "credit balance", "openrouter", "400"]) {
    assert.equal(filter.includes(vendor), false, `filter must not mention ${vendor}`);
  }
});
