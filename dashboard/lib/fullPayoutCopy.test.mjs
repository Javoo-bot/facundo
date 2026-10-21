// The "paid in full on accept" copy variants, guarded as a set.
//
// A tier with a 0% delivery leg pays a florist their whole payout on
// acceptance (tier 1 today), so a dozen strings
// that state the 70/30 split get a `*Full` sibling and one of several surfaces
// picks between them. That arrangement has two ways to rot silently, and
// neither shows up as a crash:
//
//   1. A page declares a key in its variant set that has no `*Full` in the
//      catalog. `t()` echoes a missing key back as its own text, so the page
//      renders the literal string "ui.guide.sum" to a florist. No error.
//   2. A `*Full` string gets edited (or copy-pasted from its sibling) back into
//      mentioning 70% or 30%, which is the exact sentence this whole change
//      exists to stop showing. Also no error.
//
// Locale PARITY is already covered — lib/i18n/i18n.test.mjs asserts every EN
// key resolves in all six — so this file only has to cover the two above.
//
// Run with: node --test lib/fullPayoutCopy.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { staticLookup, flattenKeys, LOCALES } from "./i18n/index.ts";
import { HELP_ARTICLES, helpKey } from "./help/content.ts";

// NOTE on what is NOT imported: `fullVariant` lives in
// lib/floristPayoutModel.ts, which pulls in next/react and so cannot be loaded
// by plain `node --test`. Its logic is one line ("swap if the key is in the
// declared set"); what actually needs guarding is that the declared set and the
// catalog agree, which is checked directly below.

/** The variant sets each page declares, read out of the page source rather than
 * duplicated here — a set that drifts from the page is exactly the failure
 * this file is for. */
function declaredKeys(file) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const block = src.match(/const PAID_IN_FULL_KEYS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, `${file}: no PAID_IN_FULL_KEYS set found — did the page stop selecting a variant?`);
  // Dotted catalog keys only. A bare /"([^"]+)"/ also swallows quoted prose out
  // of the comments inside the set, which then fails as a missing key.
  return [...block[1].matchAll(/"((?:[A-Za-z0-9_-]+\.)+[A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
}

const PAGE_SETS = {
  "app/florist/guide/page.tsx": declaredKeys("app/florist/guide/page.tsx"),
  "app/florist/how-it-works/page.tsx": declaredKeys("app/florist/how-it-works/page.tsx"),
};

test("every key a page swaps has a real *Full string behind it", () => {
  for (const [file, keys] of Object.entries(PAGE_SETS)) {
    assert.ok(keys.length > 0, `${file}: declared an empty variant set`);
    for (const key of keys) {
      assert.equal(
        typeof staticLookup("en", key),
        "string",
        `${file}: ${key} is not in the catalog at all`
      );
      assert.equal(
        typeof staticLookup("en", `${key}Full`),
        "string",
        `${file}: ${key} is swapped for ${key}Full, which does not exist — a florist would read the raw key`
      );
    }
  }
});

test("every help article declaring fullPayoutBody actually has one", () => {
  const declared = HELP_ARTICLES.filter((a) => a.fullPayoutBody);
  assert.ok(declared.length > 0, "no article declares fullPayoutBody — the swap is dead code");
  for (const a of declared) {
    for (const locale of LOCALES) {
      assert.equal(
        typeof staticLookup(locale, helpKey(a.id, "bodyFull")),
        "string",
        `${a.id}: fullPayoutBody is declared but ${locale} has no bodyFull`
      );
    }
  }
});

/** Every `*Full` key in the EN catalog, paired with its value in `locale`.
 *
 * The key list comes from flattenKeys() (which walks EN) rather than from
 * walking each locale's own tree: staticLookup only resolves LEAVES, so there
 * is no way to enumerate a subtree through it, and an earlier version of this
 * helper that tried silently found zero keys and made every assertion below
 * pass vacuously. Locale parity is guaranteed elsewhere (i18n.test.mjs), so
 * EN's key list is the right list for every locale. */
function allFullVariants(locale) {
  return flattenKeys()
    .filter((k) => k.endsWith("Full"))
    .map((k) => [k, staticLookup(locale, k)])
    .filter(([, v]) => typeof v === "string");
}

test("the variant sweep below is not vacuous", () => {
  // Guards the guard. Every assertion in the two tests that follow iterates
  // allFullVariants(); if that ever returns nothing they all pass while
  // checking nothing, which is worse than not having them.
  const found = allFullVariants("en");
  assert.ok(found.length >= 20, `expected the paid-in-full variants, found ${found.length}`);
  for (const locale of LOCALES) {
    assert.equal(
      allFullVariants(locale).length,
      found.length,
      `${locale}: has a different number of *Full strings than EN`
    );
  }
});

test("no paid-in-full string mentions the 70/30 split", () => {
  // The regression this catches: someone edits a `*Full` string by copying its
  // split sibling and adjusting a word, and the percentage comes along.
  for (const locale of LOCALES) {
    for (const [key, value] of allFullVariants(locale)) {
      assert.doesNotMatch(
        value,
        /\b70\s?%|\b30\s?%|70\/30/,
        `${locale}: ${key} is the paid-in-full variant but still states the split: ${value}`
      );
    }
  }
});

test("the paid-in-full variants all say something different from their siblings", () => {
  // A variant identical to its sibling is a translation that was never done —
  // it renders as "correct" and quietly tells a paid-in-full florist the wrong deal.
  //
  // There is no exception list, on purpose. Where a string turned out to read
  // the same on both deals (a heading, a "when does this happen" label), the
  // VARIANT was deleted and the shared string reused, rather than a duplicate
  // being kept and excused here. So the rule holds with no carve-outs: a
  // `*Full` key exists only where the wording genuinely differs.
  for (const locale of LOCALES) {
    for (const [fullKey, fullValue] of allFullVariants(locale)) {
      const baseKey = fullKey.slice(0, -"Full".length);
      const baseValue = staticLookup(locale, baseKey);
      if (typeof baseValue !== "string") continue; // a *Full with no sibling is fine
      assert.notEqual(
        fullValue,
        baseValue,
        `${locale}: ${fullKey} is identical to ${baseKey} — the variant was never written`
      );
    }
  }
});
