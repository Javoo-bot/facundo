import { test } from "node:test";
import assert from "node:assert/strict";
import { combineVerdicts, CONFIDENCE_FLOOR } from "./photoVerify/combine.ts";

// Build a successful provider result with sensible defaults.
const R = (provider, over = {}) => ({
  provider,
  ok: true,
  matched: true,
  confidence: 0.9,
  itemsFound: [],
  itemsMissing: [],
  notes: "",
  ...over,
});

test("unanimous confident match → pass", () => {
  const out = combineVerdicts([R("claude"), R("gemini")]);
  assert.equal(out.verdict, "pass");
  assert.equal(out.confidence, 0.9);
});

test("unanimous confident no-match → fail", () => {
  const out = combineVerdicts([R("claude", { matched: false }), R("gemini", { matched: false })]);
  assert.equal(out.verdict, "fail");
});

test("disagreement (one match, one no-match) → review", () => {
  const out = combineVerdicts([R("claude", { matched: true }), R("gemini", { matched: false })]);
  assert.equal(out.verdict, "review");
});

test("a low-confidence read holds the whole thing → review", () => {
  const out = combineVerdicts([R("claude"), R("gemini", { confidence: CONFIDENCE_FLOOR - 0.01 })]);
  assert.equal(out.verdict, "review");
});

test("partial delivery (items missing) → review even if matched + confident", () => {
  const out = combineVerdicts([R("claude", { itemsMissing: ["Box of chocolates"] }), R("gemini")]);
  assert.equal(out.verdict, "review");
});

test("no usable provider (all errored/disabled) → review, confidence 0", () => {
  const out = combineVerdicts([
    { provider: "claude", ok: false, matched: false, confidence: 0, itemsFound: [], itemsMissing: [], notes: "", error: "no key" },
  ]);
  assert.equal(out.verdict, "review");
  assert.equal(out.confidence, 0);
});

test("single enabled provider decides on its own", () => {
  assert.equal(combineVerdicts([R("claude")]).verdict, "pass");
  assert.equal(combineVerdicts([R("claude", { matched: false })]).verdict, "fail");
  assert.equal(combineVerdicts([R("claude", { confidence: 0.2 })]).verdict, "review");
});

test("failed provider's vote is ignored when another succeeds", () => {
  const out = combineVerdicts([
    R("claude"),
    { provider: "gemini", ok: false, matched: false, confidence: 0, itemsFound: [], itemsMissing: [], notes: "", error: "timeout" },
  ]);
  assert.equal(out.verdict, "pass"); // only Claude's successful pass counts
});

test("reasoning is a non-empty human-readable string", () => {
  const out = combineVerdicts([R("claude"), R("gemini")]);
  assert.ok(typeof out.reasoning === "string" && out.reasoning.length > 0);
});
