import test from "node:test";
import assert from "node:assert/strict";
import { isReadOnlySelect } from "./statsChatGuard.ts";

test("accepts a plain select", () => {
  const r = isReadOnlySelect("select count(*) from orders");
  assert.equal(r.ok, true);
});

test("accepts a with/select", () => {
  const r = isReadOnlySelect("with x as (select 1) select * from x");
  assert.equal(r.ok, true);
});

test("accepts a trailing semicolon and strips it", () => {
  const r = isReadOnlySelect("select 1;");
  assert.equal(r.ok, true);
  assert.equal(r.query, "select 1");
});

test("rejects insert", () => {
  const r = isReadOnlySelect("insert into orders (id) values ('x')");
  assert.equal(r.ok, false);
});

test("rejects a stacked statement", () => {
  const r = isReadOnlySelect("select 1; drop table orders;");
  assert.equal(r.ok, false);
});

test("rejects update disguised in a subquery comment", () => {
  const r = isReadOnlySelect("select 1 -- update orders set status='x'\n from orders");
  // the comment itself isn't executable, but the keyword scan is deliberately
  // conservative and rejects it anyway rather than trying to parse comments out
  assert.equal(r.ok, false);
});

test("rejects a query not starting with select/with", () => {
  const r = isReadOnlySelect("delete from orders");
  assert.equal(r.ok, false);
});

test("rejects pg_sleep", () => {
  const r = isReadOnlySelect("select pg_sleep(10)");
  assert.equal(r.ok, false);
});

test("rejects empty input", () => {
  const r = isReadOnlySelect("   ");
  assert.equal(r.ok, false);
});

// ---- comment / bracket rejection -------------------------------------------
// The database is what actually stops these now (every query runs as
// stats_reader through a cursor, so caller text can't restructure our SQL) —
// see supabase/migrations/2026-08-05-stats-reader-role.sql. These cases are the
// cheap first pass: the exact shape that used to break out of the old
// format()-built wrapper, rejected before it reaches the database at all.

test("rejects the wrapper-escape shape: closes our parens, comments out the tail", () => {
  // Against the old `... from (select * from (%s) sub limit 500) t` wrapper this
  // exact string returned 3988 rows against a 500 cap.
  const r = isReadOnlySelect("select id from orders) sub limit 5000) t --");
  assert.equal(r.ok, false);
});

test("rejects a line comment", () => {
  const r = isReadOnlySelect("select 1 -- trailing");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "SQL comments are not allowed");
});

test("rejects a block comment", () => {
  assert.equal(isReadOnlySelect("select /* hi */ 1").ok, false);
  assert.equal(isReadOnlySelect("with x as (select 1 /* sneaky */) select * from x").ok, false);
});

test("arithmetic that merely looks comment-ish is still accepted", () => {
  // Only comment *openers* are rejected, so `count(*)/count(*)` and friends
  // don't get caught by a stray `*/`-style check.
  const r = isReadOnlySelect(
    "select sum(payout_price) * 100.0 / nullif(count(*), 0) as pct from order_assignments"
  );
  assert.equal(r.ok, true);
});

test("rejects unbalanced parentheses in either direction", () => {
  const extraClose = isReadOnlySelect("select count(*) from orders) sub");
  assert.equal(extraClose.ok, false);
  assert.equal(extraClose.reason, "unbalanced parentheses");
  assert.equal(isReadOnlySelect("select count(*) from (select 1 as x").ok, false);
});

test("balanced nesting is still accepted", () => {
  const r = isReadOnlySelect(
    "select f.name from florists f where f.id in (select florist_id from order_assignments where status in ('accepted', 'delivered'))"
  );
  assert.equal(r.ok, true);
});

// ---- string literals must not trip the new checks --------------------------

test("accepts parentheses and dashes inside a string literal", () => {
  // A florist really is called this; `--` inside a literal is not a comment.
  const r = isReadOnlySelect("select * from florists where name = 'Flors (Girona) -- centre'");
  assert.equal(r.ok, true);
});

test("accepts a doubled-quote escape inside a literal", () => {
  const r = isReadOnlySelect("select * from florists where name = 'L''Hort (Vell)'");
  assert.equal(r.ok, true);
});

test("a disallowed keyword inside a string literal is data, not SQL", () => {
  // "Create Your Own ..." is an everyday product title; scanning the raw text
  // for \bcreate\b rejected a perfectly ordinary query.
  const r = isReadOnlySelect(
    "select count(*) from order_line_items where product_title = 'Create Your Own Bouquet'"
  );
  assert.equal(r.ok, true);
  assert.equal(isReadOnlySelect("select * from florists where name like '%Lock%'").ok, true);
});

test("the same keyword outside a literal is still rejected", () => {
  assert.equal(isReadOnlySelect("select 1 from orders where x = 'safe' union select create").ok, false);
  // The comment case from above still fails on the keyword scan too, not just
  // on the comment rule: stripping `'x'` leaves `update` in the open.
  const r = isReadOnlySelect("select 1 /? update orders set status='x' ?/ from orders".replace(/\?/g, "*"));
  assert.equal(r.ok, false);
});

test("a comment hidden after a closing quote is still rejected", () => {
  const r = isReadOnlySelect("select * from florists where name = 'x' -- and now a comment");
  assert.equal(r.ok, false);
});

test("returns the query unchanged when it passes", () => {
  // The guard is a filter, not a rewriter — only a trailing ';' is stripped.
  const q = "select status, count(*) from orders group by status";
  const r = isReadOnlySelect(`  ${q};  `);
  assert.equal(r.ok, true);
  assert.equal(r.query, q);
});
