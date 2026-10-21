import test from "node:test";
import assert from "node:assert/strict";
import {
  HELP_ARTICLES,
  HELP_CATEGORIES,
  HELP_CHROME_FIELDS,
  HELP_PENDING_KEYS,
  helpSections,
  helpCopyKeys,
  findArticle,
  helpKey,
} from "./content.ts";
import { t, staticLookup, flattenKeys, LOCALES } from "../i18n/index.ts";

// The Q&A splits structure (content.ts) from copy (the i18n catalog), which
// means the two can drift: an article whose strings were never written renders
// as its own key ("ui.help.a.foo.q") in a florist's face. These tests are the
// join between them.

const ids = HELP_ARTICLES.map((a) => a.id);

test("article ids are unique", () => {
  assert.equal(new Set(ids).size, ids.length);
});

test("every article sits in a declared category", () => {
  for (const a of HELP_ARTICLES) assert.ok(HELP_CATEGORIES.includes(a.category), `${a.id}: ${a.category}`);
});

test("every article has a question and a body in EN", () => {
  for (const a of HELP_ARTICLES) {
    assert.equal(typeof staticLookup("en", helpKey(a.id, "q")), "string", `${a.id}: missing .q`);
    assert.equal(typeof staticLookup("en", helpKey(a.id, "body")), "string", `${a.id}: missing .body`);
  }
});

test("every category has a label in EN", () => {
  for (const c of HELP_CATEGORIES) {
    assert.equal(typeof staticLookup("en", `ui.help.cat.${c}`), "string", `category ${c}`);
  }
});

// Falling back to EN is right for a key nobody has got to yet, but this page is
// read by florists who were emailed in their own language — a Spanish Q&A that
// answers half its questions in English is worse than not shipping it. Every
// supported locale carries the whole thing.
test("every article is translated into every supported locale", () => {
  for (const locale of LOCALES) {
    for (const a of HELP_ARTICLES) {
      assert.equal(typeof staticLookup(locale, helpKey(a.id, "q")), "string", `${locale}/${a.id}: missing .q`);
      assert.equal(typeof staticLookup(locale, helpKey(a.id, "body")), "string", `${locale}/${a.id}: missing .body`);
    }
    for (const c of HELP_CATEGORIES) {
      assert.equal(typeof staticLookup(locale, `ui.help.cat.${c}`), "string", `${locale}: category ${c}`);
    }
  }
});

test("the page's own chrome is translated into every supported locale", () => {
  const chrome = [
    "ui.help.title",
    "ui.help.backToOrder",
    "ui.help.backNote",
    "ui.help.relatedLead",
    "ui.help.howItWorksLink",
    "ui.help.joinTitle",
    "ui.help.joinBody",
  ];
  for (const locale of LOCALES) {
    for (const key of chrome) {
      assert.equal(typeof staticLookup(locale, key), "string", `${locale}: ${key}`);
    }
  }
});

// `ui.help.a.contact-us.body` carries {supportEmail}, and the renderer resolved
// article bodies with NO vars — so every florist, in all six languages, was
// told to "write to {supportEmail}". It shipped that way. This is the guard:
// once the vars the page actually passes are supplied, nothing may be left
// looking like a placeholder.
test("no answer renders with an unresolved {placeholder}", () => {
  // Exactly what HelpCenter passes to tt() for an article body.
  const vars = { supportEmail: "florists@fc.example.com" };
  for (const locale of LOCALES) {
    for (const a of HELP_ARTICLES) {
      for (const part of ["q", "body"]) {
        const rendered = t(locale, helpKey(a.id, part), vars);
        const leftover = rendered.match(/\{(\w+)\}/g);
        assert.equal(leftover, null, `${locale}/${a.id}.${part} still has ${leftover?.join(", ")}`);
      }
    }
  }
});

test("every screenshot callout has a label in every locale, positioned on the image", () => {
  for (const a of HELP_ARTICLES) {
    if (a.media?.kind !== "image") continue;
    for (const c of a.media.callouts ?? []) {
      assert.ok(c.x >= 0 && c.x <= 100, `${a.id}/${c.n}: x off the image`);
      assert.ok(c.y >= 0 && c.y <= 100, `${a.id}/${c.n}: y off the image`);
      for (const locale of LOCALES) {
        assert.equal(
          typeof staticLookup(locale, helpKey(a.id, `callout${c.n}`)),
          "string",
          `${locale}/${a.id}: missing callout${c.n}`
        );
      }
    }
  }
});

test("video media declares only supported caption locales", () => {
  for (const a of HELP_ARTICLES) {
    if (a.media?.kind !== "video") continue;
    for (const loc of a.media.captions) assert.ok(LOCALES.includes(loc), `${a.id}: caption locale ${loc}`);
  }
});

test("related links point at articles that exist", () => {
  for (const a of HELP_ARTICLES) {
    for (const id of a.related ?? []) {
      assert.ok(ids.includes(id), `${a.id} -> ${id}`);
      assert.notEqual(id, a.id, `${a.id} relates to itself`);
    }
  }
});

test("the public surface drops app-only answers, the in-app one keeps them", () => {
  const flat = (variant) => helpSections(variant).flatMap((s) => s.articles.map((a) => a.id));
  const appOnly = HELP_ARTICLES.filter((a) => a.appOnly).map((a) => a.id);
  assert.ok(appOnly.length > 0, "no app-only article left to prove the filter works");
  for (const id of appOnly) {
    assert.ok(!flat("public").includes(id), `${id} leaked onto the public page`);
    assert.ok(flat("app").includes(id), `${id} missing from the in-app page`);
  }
  assert.equal(flat("app").length, HELP_ARTICLES.length);
});

test("sections come back in category order and lose nothing", () => {
  const sections = helpSections("app");
  assert.deepEqual(
    sections.map((s) => s.category),
    HELP_CATEGORIES.filter((c) => HELP_ARTICLES.some((a) => a.category === c))
  );
});

// ---- the backoffice editor (app/(staff)/faq) ----
// The editor builds its field list from helpCopyKeys(). If a string is
// rendered by HelpCenter but missing from that list, it becomes the one line
// staff can't fix without a deploy — which is the whole point of the page.
// Conversely a key nobody renders is dead copy that still demands a
// translation. Both directions are checked against the EN catalog.
test("every ui.help.* string in the catalog is editable from the backoffice", () => {
  const catalog = flattenKeys().filter((k) => k.startsWith("ui.help."));
  const editable = new Set(helpCopyKeys());
  const pending = new Set(HELP_PENDING_KEYS);
  for (const key of catalog) {
    assert.ok(
      editable.has(key) || pending.has(key),
      `${key} is rendered but not editable at /faq — add it to HELP_CHROME_FIELDS`
    );
  }
});

// The forcing function: the moment an article's `media` block is restored,
// helpCopyKeys() starts covering its callouts and this fails until the pending
// list is cleared. Parked copy can't quietly stay parked.
test("pending copy is genuinely unrendered, and every pending key has copy behind it", () => {
  const editable = new Set(helpCopyKeys());
  for (const key of HELP_PENDING_KEYS) {
    assert.ok(!editable.has(key), `${key} is rendered now — remove it from HELP_PENDING_KEYS`);
    assert.equal(typeof staticLookup("en", key), "string", `${key} is parked but has no copy`);
  }
});

test("the editor lists no key that doesn't exist in the catalog", () => {
  for (const key of helpCopyKeys()) {
    assert.equal(typeof staticLookup("en", key), "string", `/faq offers ${key}, which has no copy behind it`);
  }
});

test("chrome fields are unique and carry a label", () => {
  const keys = HELP_CHROME_FIELDS.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const f of HELP_CHROME_FIELDS) assert.ok(f.label.trim().length > 0, f.key);
});

test("findArticle resolves a deep link and shrugs off a bad one", () => {
  assert.equal(findArticle(HELP_ARTICLES[0].id)?.id, HELP_ARTICLES[0].id);
  // An old or hand-edited ?a= must not 404 the page — it just opens nothing.
  assert.equal(findArticle("no-such-article"), null);
  assert.equal(findArticle(undefined), null);
  assert.equal(findArticle(""), null);
});
