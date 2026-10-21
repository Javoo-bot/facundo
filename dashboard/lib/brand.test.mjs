import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBrand } from "./brand.ts";

test("only the exact value switches to Smart design", () => {
  assert.equal(parseBrand("smart-design"), "smart-design");
  assert.equal(parseBrand(undefined), "facundo");
  assert.equal(parseBrand(""), "facundo");
  assert.equal(parseBrand("Smart-Design"), "facundo");
  assert.equal(parseBrand("garden"), "facundo");
});

test("Smart design renames the six staff screens and nothing else", async () => {
  const { titleFor } = await import("./brand.ts");
  assert.equal(titleFor("smart-design", "Control panel"), "Today");
  assert.equal(titleFor("smart-design", "Statistics & Insights"), "Reports");
  assert.equal(titleFor("smart-design", "Settings"), "Settings");
  assert.equal(titleFor("facundo", "Control panel"), "Control panel");
});
