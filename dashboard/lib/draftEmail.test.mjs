import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTargetLanguage, buildDraftPrompt } from "./draftEmail.ts";

// The approved email the prompt now wraps. Rendered from the catalog in
// production (lib/recruitingContent.ts) — a literal here keeps these tests
// about the PROMPT, not about the copy.
const CANONICAL = {
  subject: "Flower orders in Lyon, paid 70% up front",
  body: "Hi there,\n\nFacundo is an international flower delivery service.\n\n1. We send you the bouquet, address, date and price.",
};

test("resolveTargetLanguage: content wins, then region, then en", () => {
  assert.equal(resolveTargetLanguage("ca", "es"), "ca");
  assert.equal(resolveTargetLanguage(null, "es"), "es");
  assert.equal(resolveTargetLanguage("  ", "es"), "es");
  assert.equal(resolveTargetLanguage(null, null), "en");
  assert.equal(resolveTargetLanguage("", ""), "en");
});

test("buildDraftPrompt keeps the literal Subject: contract and target language", () => {
  const p = buildDraftPrompt(
    { name: "Fleurs de Paris", rating: 4.8, review_count: 120, owner_name: null, shop_highlight: null },
    "Lyon",
    "fr",
    CANONICAL
  );
  assert.ok(p.includes('"Subject:"'));
  assert.ok(p.includes("fr"));
  assert.ok(p.includes("Fleurs de Paris"));
});

test("buildDraftPrompt: owner name drives a personal greeting instruction", () => {
  const p = buildDraftPrompt(
    { name: "X", rating: null, review_count: null, owner_name: "Marie", shop_highlight: null },
    "Lyon",
    "fr",
    CANONICAL
  );
  assert.ok(p.includes("greet Marie personally"));
});

test("buildDraftPrompt: highlight opening takes priority over rating", () => {
  const withHighlight = buildDraftPrompt(
    { name: "X", rating: 4.9, review_count: 50, owner_name: null, shop_highlight: "hand-tied seasonal bouquets" },
    "Lyon",
    "fr",
    CANONICAL
  );
  assert.ok(withHighlight.includes("hand-tied seasonal bouquets"));

  const ratingOpening = buildDraftPrompt(
    { name: "X", rating: 4.9, review_count: 50, owner_name: null, shop_highlight: null },
    "Lyon",
    "fr",
    CANONICAL
  );
  assert.ok(ratingOpening.includes("4.9-star rating across 50 reviews"));

  const generic = buildDraftPrompt(
    { name: "X", rating: null, review_count: null, owner_name: null, shop_highlight: null },
    "Lyon",
    "fr",
    CANONICAL
  );
  assert.ok(generic.includes("stood out while we researched"));
  // The old prompt padded its reference facts with "an unrated" shop and
  // "several" reviews when we had neither — inviting the model to write about
  // reviews it had no evidence for. It now says so explicitly instead.
  assert.ok(!generic.includes("an unrated"));
  assert.ok(/do not claim to have read their reviews/i.test(generic));
});

test("buildDraftPrompt hands the approved email over verbatim, so the catalog stays the source of truth", () => {
  const p = buildDraftPrompt(
    { name: "X", rating: null, review_count: null, owner_name: null, shop_highlight: null },
    "Lyon",
    "fr",
    CANONICAL
  );
  assert.ok(p.includes(CANONICAL.subject), "approved subject missing from prompt");
  assert.ok(p.includes("1. We send you the bouquet, address, date and price."), "approved body missing");
  // The terms are the part that must not drift when the model rewrites.
  assert.ok(/must all survive/i.test(p));
  assert.ok(/70%/.test(p) && /30%/.test(p));
});

test("buildDraftPrompt forbids claiming reviews we do not have", () => {
  const p = buildDraftPrompt(
    { name: "X", rating: null, review_count: null, owner_name: null, shop_highlight: null },
    "Lyon",
    "fr",
    CANONICAL
  );
  assert.ok(/do not claim to have read their reviews/i.test(p));
});

test("buildDraftPrompt uses a researched highlight over the ratings opening when we have one", () => {
  const p = buildDraftPrompt(
    { name: "X", rating: 4.8, review_count: 120, owner_name: null, shop_highlight: "hand-tied seasonal bouquets" },
    "Lyon",
    "fr",
    CANONICAL
  );
  assert.ok(p.includes("hand-tied seasonal bouquets"));
  assert.ok(!p.includes("4.8-star"), "highlight and ratings openings both rendered");
});

test("buildDraftPrompt tells the model to copy any join URL character for character", () => {
  const p = buildDraftPrompt(
    { name: "X", rating: null, review_count: null, owner_name: null, shop_highlight: null },
    "Lyon",
    "fr",
    CANONICAL
  );
  assert.ok(/character for character/i.test(p));
  assert.ok(/never invent one/i.test(p));
});
