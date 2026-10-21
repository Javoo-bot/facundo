import { test } from "node:test";
import assert from "node:assert/strict";
import {
  escapeLikeTerm,
  parseFloristOptionsParams,
  BASIC_COLUMNS,
  DETAIL_COLUMNS,
} from "./floristOptions.ts";

test("limit defaults to 50 when absent", () => {
  const p = parseFloristOptionsParams(new URLSearchParams());
  assert.equal(p.limit, 50);
});

test("limit clamps at the floor of 1", () => {
  const p = parseFloristOptionsParams(new URLSearchParams("limit=0"));
  assert.equal(p.limit, 1);
  const negative = parseFloristOptionsParams(new URLSearchParams("limit=-5"));
  assert.equal(negative.limit, 1);
});

test("limit clamps at the ceiling of 1000", () => {
  const p = parseFloristOptionsParams(new URLSearchParams("limit=5000"));
  assert.equal(p.limit, 1000);
});

test("non-numeric limit falls back to the default of 50", () => {
  const p = parseFloristOptionsParams(new URLSearchParams("limit=abc"));
  assert.equal(p.limit, 50);
});

test("escapeLikeTerm escapes % and _ wildcards", () => {
  assert.equal(escapeLikeTerm("100%_off"), "100\\%\\_off");
  assert.equal(escapeLikeTerm("Rose & Co"), "Rose & Co");
});

test("detail absent selects the basic id, name column set", () => {
  const p = parseFloristOptionsParams(new URLSearchParams());
  assert.equal(p.detail, false);
  assert.equal(p.columns, BASIC_COLUMNS);
  assert.equal(p.columns, "id, name");
});

test("detail=1 selects the full FloristDirectoryEntry column set", () => {
  const p = parseFloristOptionsParams(new URLSearchParams("detail=1"));
  assert.equal(p.detail, true);
  assert.equal(p.columns, DETAIL_COLUMNS);
  assert.equal(p.columns, "id, name, lifecycle_stage, trust_tier, address, city_id, excluded_at");
});

test("detail values other than the literal '1' behave as absent", () => {
  for (const v of ["true", "yes", "0", ""]) {
    const p = parseFloristOptionsParams(new URLSearchParams(`detail=${v}`));
    assert.equal(p.detail, false, `detail=${v} should not enable detail mode`);
    assert.equal(p.columns, BASIC_COLUMNS);
  }
});

test("includeExcluded defaults to false, enabled only by the literal '1'", () => {
  assert.equal(parseFloristOptionsParams(new URLSearchParams()).includeExcluded, false);
  assert.equal(parseFloristOptionsParams(new URLSearchParams("includeExcluded=1")).includeExcluded, true);
  assert.equal(parseFloristOptionsParams(new URLSearchParams("includeExcluded=true")).includeExcluded, false);
  assert.equal(parseFloristOptionsParams(new URLSearchParams("includeExcluded=0")).includeExcluded, false);
});

test("withEmail defaults to true, disabled only by the literal '0'", () => {
  assert.equal(parseFloristOptionsParams(new URLSearchParams()).withEmail, true);
  assert.equal(parseFloristOptionsParams(new URLSearchParams("withEmail=0")).withEmail, false);
  assert.equal(parseFloristOptionsParams(new URLSearchParams("withEmail=false")).withEmail, true);
  assert.equal(parseFloristOptionsParams(new URLSearchParams("withEmail=1")).withEmail, true);
});

test("q is trimmed", () => {
  const p = parseFloristOptionsParams(new URLSearchParams("q=%20rose%20"));
  assert.equal(p.q, "rose");
});

test("q defaults to empty string when absent", () => {
  const p = parseFloristOptionsParams(new URLSearchParams());
  assert.equal(p.q, "");
});
