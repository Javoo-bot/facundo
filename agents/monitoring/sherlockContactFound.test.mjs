// node --test agents/monitoring/sherlockContactFound.test.mjs
//
// Proves the `contact-found` case-selection WHERE clause in schema.sql's
// `sherlock` CTE against representative florist rows, using an in-memory
// SQLite table — the sandbox this runs in has no Postgres. The clause is
// extracted verbatim from schema.sql (not retyped by hand), so a future edit
// to the real view is what this test checks, not a hand-maintained copy.
//
// SQLite has no ILIKE; its LIKE is already ASCII case-insensitive, so `ilike`
// is rewritten to `like` for execution only — the pattern and semantics are
// unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, "schema.sql"), "utf8");

function extractSherlockContactFoundWhere(sql) {
  const m = sql.match(
    /sherlock as \(\s*select 'sherlock' as agent, 'contact-found'[\s\S]*?from florists f\s*([\s\S]*?)\n    union all/
  );
  if (!m) throw new Error("could not find the sherlock contact-found CTE in schema.sql");
  return m[1].replace(/\bilike\b/gi, "like");
}

const ROWS = [
  {
    id: "unchecked-free-layer",
    has_website: 1,
    ingested_at: "2026-10-13T08:00:00Z",
    enrichment_ai_context: null,
    enrichment_notes: "Unchecked — email, phone and owner unknown until the paid check.",
    email: null,
    phone_web: null,
  },
  {
    id: "never-reached",
    has_website: 1,
    ingested_at: "2026-10-13T08:00:00Z",
    enrichment_ai_context: null,
    enrichment_notes: null,
    email: null,
    phone_web: null,
  },
  {
    id: "real-run-found-contact",
    has_website: 1,
    ingested_at: "2026-10-13T08:00:00Z",
    enrichment_ai_context: '{"agent":"sherlock"}',
    enrichment_notes: "Crawled 3 page(s). Email: 2 candidate(s) → hi@shop.com.",
    email: "hi@shop.com",
    phone_web: null,
  },
  {
    id: "real-run-no-contact",
    has_website: 1,
    ingested_at: "2026-10-13T08:00:00Z",
    enrichment_ai_context: '{"agent":"sherlock"}',
    enrichment_notes: "Crawled 3 page(s). Email: 1 candidate(s) → none (no genuine primary email).",
    email: null,
    phone_web: null,
  },
  {
    id: "crawl-failed-real-attempt",
    has_website: 1,
    ingested_at: "2026-10-13T08:00:00Z",
    enrichment_ai_context: null,
    enrichment_notes: "Homepage http://x.fr/ was unreachable (static and headless both failed).",
    email: null,
    phone_web: null,
  },
];

function runWhere(whereSql) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "create table florists (id text, has_website integer, ingested_at text, enrichment_ai_context text, enrichment_notes text, email text, phone_web text)"
  );
  const insert = db.prepare(
    "insert into florists values (:id, :has_website, :ingested_at, :enrichment_ai_context, :enrichment_notes, :email, :phone_web)"
  );
  for (const r of ROWS) insert.run(r);
  const rows = db.prepare(`select f.id as id from florists f ${whereSql}`).all();
  db.close();
  return rows.map((r) => r.id).sort();
}

test("contact-found counts a florist only once Sherlock actually ran on it", () => {
  const where = extractSherlockContactFoundWhere(schema);
  const cases = runWhere(where);

  // The bug this fixes: an un-enriched free-place-layer import (enrichment_notes
  // set to a non-null "Unchecked ..." placeholder) must not be a case.
  assert.equal(cases.includes("unchecked-free-layer"), false, "an un-enriched free-layer shop must not count as a Sherlock case");

  // Enrichment that genuinely never reached the row (no notes at all) isn't a
  // case either — same as repair.ts's own "never reached" semantics.
  assert.equal(cases.includes("never-reached"), false);

  // A real crawl — whether it found a contact, found nothing, or couldn't
  // reach the site — is Sherlock having actually run, so it IS a case.
  assert.deepEqual(cases, ["crawl-failed-real-attempt", "real-run-found-contact", "real-run-no-contact"]);
});
