import test from "node:test";
import assert from "node:assert/strict";
import { SUPPORT_HELP_ARTICLE_IDS, SUPPORT_HELP_ARTICLES, buildPublishedHelpLines } from "./publishedHelp.ts";
import { HELP_ARTICLES } from "../help/content.ts";
import { LOCALES } from "../i18n/index.ts";

test("every configured id resolves to a real help article", () => {
  assert.equal(SUPPORT_HELP_ARTICLES.length, SUPPORT_HELP_ARTICLE_IDS.length);
  const ids = new Set(HELP_ARTICLES.map((a) => a.id));
  for (const id of SUPPORT_HELP_ARTICLE_IDS) assert.ok(ids.has(id), `${id} is not a real help article`);
});

test("the v1 topics from the scope doc are covered", () => {
  for (const id of [
    "getting-paid", "the-card", "missing-flower", "delivery-photo",
    "accept-an-order", "install-app", "working-language", "teammates",
    "how-offers-arrive", "what-do-i-make", "photo-not-approved",
  ]) {
    assert.ok(SUPPORT_HELP_ARTICLE_IDS.includes(id), `missing v1 topic: ${id}`);
  }
});

test("live/substantive order-problem articles are excluded, on purpose", () => {
  // wrong-address and cant-fulfil are delivery_problem territory — a
  // policy-shaped answer to either would read as settling a real, in-flight
  // case, which is exactly what this grounding must not do.
  for (const id of ["wrong-address", "cant-fulfil"]) {
    assert.ok(!SUPPORT_HELP_ARTICLE_IDS.includes(id), `${id} should not be answerable content`);
  }
});

test("every locale renders one non-empty line per configured article", () => {
  for (const locale of LOCALES) {
    const lines = buildPublishedHelpLines({}, locale);
    assert.equal(lines.length, SUPPORT_HELP_ARTICLE_IDS.length);
    for (const line of lines) {
      assert.ok(line.startsWith("Q: "), line);
      assert.ok(line.includes(" A: "), line);
    }
  }
});

test("the corrected substitution rule is what ships", () => {
  const lines = buildPublishedHelpLines({}, "en");
  const substitution = lines.find((l) => l.includes("out of a flower"));
  assert.ok(substitution, "missing-flower line not found");
  assert.match(substitution, /30%/);
  assert.match(substitution, /Roses can.t be swapped/);
});

test("payment timing/immediacy and card-only wording are present", () => {
  const lines = buildPublishedHelpLines({}, "en");
  const paid = lines.find((l) => l.includes("How and when do I get paid"));
  assert.match(paid, /70%.*immediately/);
  assert.match(paid, /remaining 30%/);
  const card = lines.find((l) => l.includes("Facundo card work"));
  assert.match(card, /only payout method we support today/);
});

test("no line ever states a bare currency amount", () => {
  // Percentages (70/30/100) are already always-allowed by the money guard;
  // a currency figure is not, and none of the configured articles should ever
  // need one. This is the regression guard for that invariant.
  const moneyPattern = /[€$£¥]|\b\d+([.,]\d+)?\s*(EUR|USD|GBP)\b/i;
  for (const locale of LOCALES) {
    for (const line of buildPublishedHelpLines({}, locale)) {
      assert.doesNotMatch(line, moneyPattern, `${locale}: ${line}`);
    }
  }
});

test("staff overrides win over the catalog wording", () => {
  const overrides = { "ui.help.a.getting-paid.q": "OVERRIDDEN QUESTION" };
  const lines = buildPublishedHelpLines(overrides, "en");
  assert.ok(lines.some((l) => l.startsWith("Q: OVERRIDDEN QUESTION")));
});
