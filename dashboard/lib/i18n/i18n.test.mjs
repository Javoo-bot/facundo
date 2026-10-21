import test from "node:test";
import assert from "node:assert/strict";
import {
  t,
  tWithOverrides,
  staticLookup,
  flattenKeys,
  resolveLocale,
  resolveFloristLocale,
  regionToLocale,
  regionImpliesEnglish,
  isUnintendedEnglish,
  isLocale,
  LOCALES,
  DEFAULT_LOCALE,
} from "./index.ts";

test("t() looks up a dot-path key in the requested locale", () => {
  assert.equal(t("en", "email.shell.footer"), "Facundo · automated message");
});

// These test t()'s MECHANICS, not anyone's copy, so they use
// email.issue.repliedSubject: a one-var key whose {orderLabel} is structural
// (the subject is meaningless without it). Earlier revisions pointed at
// email.offer.subjectNoCity and then at sms.offer.bodyNoCity, and both broke
// when a copy pass changed which placeholders those strings carried.
test("t() interpolates {var} placeholders from vars", () => {
  const out = t("en", "email.issue.repliedSubject", { orderLabel: "#1234" });
  assert.equal(out, "Facundo replied about #1234");
});

test("t() leaves an unmatched {var} token untouched rather than throwing", () => {
  const out = t("en", "email.issue.repliedSubject", { somethingElse: "x" }); // no `orderLabel`
  assert.ok(out.includes("{orderLabel}"));
});

test("t() falls back to EN for a locale that hasn't translated a key (email.client.* stays English-only by design)", () => {
  assert.equal(t("fr", "email.client.delivered.subject"), t("en", "email.client.delivered.subject"));
});

test("t() returns the key itself when it's genuinely absent from every locale", () => {
  assert.equal(t("en", "email.nope.not.a.real.key"), "email.nope.not.a.real.key");
});

test("t() does not throw when a key path walks through a string leaf", () => {
  // "email.shell.footer.tooDeep" tries to index into a string — must degrade
  // to the not-found path, not throw.
  assert.equal(t("en", "email.shell.footer.tooDeep"), "email.shell.footer.tooDeep");
});

test("resolveLocale returns the value when it's a supported locale", () => {
  assert.equal(resolveLocale("fr"), "fr");
  assert.equal(resolveLocale("de"), "de");
});

test("resolveLocale falls back to DEFAULT_LOCALE for null, undefined, or unsupported values", () => {
  assert.equal(resolveLocale(null), DEFAULT_LOCALE);
  assert.equal(resolveLocale(undefined), DEFAULT_LOCALE);
  assert.equal(resolveLocale("klingon"), DEFAULT_LOCALE);
  assert.equal(resolveLocale(""), DEFAULT_LOCALE);
});

test("isLocale is true for exactly the LOCALES list and false otherwise", () => {
  for (const l of LOCALES) assert.ok(isLocale(l));
  assert.ok(!isLocale("xx"));
  assert.ok(!isLocale(null));
  assert.ok(!isLocale(42));
});

test("resolveFloristLocale reads florist.locale and falls back to EN when unset/invalid", () => {
  assert.equal(resolveFloristLocale({ locale: "es" }), "es");
  assert.equal(resolveFloristLocale({ locale: null }), DEFAULT_LOCALE);
  assert.equal(resolveFloristLocale({}), DEFAULT_LOCALE);
  assert.equal(resolveFloristLocale({ locale: "not-a-locale" }), DEFAULT_LOCALE);
});

test("resolveFloristLocale falls back to the florist's country when the column is null", () => {
  // The Paris regression: 200 florists ingested by a build with no locale
  // derivation, so a French shop was emailed in English. See ingest/backfill_locales.py.
  assert.equal(resolveFloristLocale({ locale: null }, "FR"), "fr");
  assert.equal(resolveFloristLocale({}, "es"), "es"); // region is case-insensitive
  // A stored locale always beats the country — a florist who picked their own
  // language must not be overridden by where their shop happens to sit.
  assert.equal(resolveFloristLocale({ locale: "en" }, "FR"), "en");
  assert.equal(resolveFloristLocale({ locale: "de" }, "FR"), "de");
  // Country that implies no supported non-English language → still EN.
  assert.equal(resolveFloristLocale({ locale: null }, "US"), DEFAULT_LOCALE);
  assert.equal(resolveFloristLocale({ locale: null }, null), DEFAULT_LOCALE);
});

test("regionToLocale maps alpha-2 regions and returns null for unmapped ones", () => {
  assert.equal(regionToLocale("FR"), "fr");
  assert.equal(regionToLocale(" it "), "it");
  assert.equal(regionToLocale("US"), null);
  assert.equal(regionToLocale(null), null);
  assert.equal(regionToLocale(undefined), null);
});

// The 2026-09-16 additions. Each of these was resolving to EN in production —
// AT covers 200 Vienna shops, the LatAm block ~845 more.
test("regionToLocale covers Austria and the Spanish-speaking Americas", () => {
  assert.equal(regionToLocale("AT"), "de");
  for (const r of ["AR", "BO", "CL", "CO", "CR", "CU", "DO", "EC", "GT", "HN",
                   "MX", "NI", "PA", "PE", "PR", "PY", "SV", "UY", "VE"]) {
    assert.equal(regionToLocale(r), "es", `${r} should map to es`);
  }
});

// Business decisions confirmed 2026-09-16, not inferred from language data.
test("regionToLocale maps Andorra to Spanish and Morocco/Tunisia to French", () => {
  assert.equal(regionToLocale("AD"), "es");
  assert.equal(regionToLocale("MA"), "fr");
  assert.equal(regionToLocale("TN"), "fr");
});

// Guard, not an oversight: a country-code map CANNOT answer these, and a wrong
// guess is worse than EN — CH -> "fr" would send French to Zurich and Basel.
// If this test ever fails, whoever added the entry needs the shop's own
// address, not a country code.
test("regionToLocale leaves multilingual countries unmapped on purpose", () => {
  assert.equal(regionToLocale("CH"), null);
  assert.equal(regionToLocale("BE"), null);
  assert.equal(regionToLocale("LU"), null);
});

test("regionImpliesEnglish knows English-defaulting countries from unmapped ones", () => {
  assert.equal(regionImpliesEnglish("GB"), true);
  assert.equal(regionImpliesEnglish(" us "), true);
  assert.equal(regionImpliesEnglish("CH"), false);
  assert.equal(regionImpliesEnglish("PL"), false);
  assert.equal(regionImpliesEnglish(null), false);
});

test("isUnintendedEnglish separates a correct EN from a silent gap", () => {
  // A stored locale is a choice — including an explicit "en".
  assert.equal(isUnintendedEnglish({ locale: "fr" }, "CH"), false);
  assert.equal(isUnintendedEnglish({ locale: "en" }, "CH"), false);
  // Nothing to judge against.
  assert.equal(isUnintendedEnglish({ locale: null }, null), false);
  assert.equal(isUnintendedEnglish({ locale: null }, "  "), false);
  // Resolved to a real locale — not a gap.
  assert.equal(isUnintendedEnglish({ locale: null }, "FR"), false);
  assert.equal(isUnintendedEnglish({ locale: null }, "AT"), false);
  // English is genuinely right here.
  assert.equal(isUnintendedEnglish({ locale: null }, "GB"), false);
  // The two real gaps: multilingual, and no catalog for the language at all.
  assert.equal(isUnintendedEnglish({ locale: null }, "CH"), true);
  assert.equal(isUnintendedEnglish({}, "ch"), true);
  assert.equal(isUnintendedEnglish({ locale: null }, "PL"), true);
  assert.equal(isUnintendedEnglish({ locale: null }, "DK"), true);
});

// The exact shape that cost us order #2000034: a French shop in Cranves-Sales
// ingested under the Swiss city of Founex, locale never set.
test("isUnintendedEnglish flags the order #2000034 florist", () => {
  const jourDeFleuraison = { locale: null };
  assert.equal(resolveFloristLocale(jourDeFleuraison, "CH"), "en");
  assert.equal(isUnintendedEnglish(jourDeFleuraison, "CH"), true);
});

test("issueLabel resolves a known issue type to its EN label", async () => {
  const { issueLabel } = await import("./issueLabels.ts");
  assert.equal(issueLabel("en", "missing_ingredient"), "Missing ingredient");
  assert.equal(issueLabel("en", "wrong_address"), "Wrong address");
});

test("issueLabel falls back to the generic 'other' label for an unrecognized type", async () => {
  const { issueLabel } = await import("./issueLabels.ts");
  assert.equal(issueLabel("en", "some_future_type"), issueLabel("en", "other"));
  assert.equal(issueLabel("en", "other"), "Issue");
});

test("issueLabel applies a passed-in overrides map (runtime DB-override layer)", async () => {
  const { issueLabel } = await import("./issueLabels.ts");
  assert.equal(
    issueLabel("en", "missing_ingredient", { "issueLabel.missing_ingredient": "Ingredient not in stock" }),
    "Ingredient not in stock"
  );
  // Empty/omitted overrides is byte-identical to the old plain-t() behavior.
  assert.equal(issueLabel("en", "missing_ingredient", {}), issueLabel("en", "missing_ingredient"));
});

// ---- tWithOverrides (runtime DB-override layer) ----

test("tWithOverrides returns the override when the key is present in the overrides map", () => {
  const overrides = { "email.shell.footer": "Overridden footer text" };
  assert.equal(tWithOverrides(overrides, "en", "email.shell.footer"), "Overridden footer text");
});

test("tWithOverrides falls back to t() when the key is absent from overrides", () => {
  assert.equal(tWithOverrides({}, "en", "email.shell.footer"), t("en", "email.shell.footer"));
  assert.equal(
    tWithOverrides({ "some.other.key": "x" }, "en", "email.shell.footer"),
    t("en", "email.shell.footer")
  );
});

test("tWithOverrides interpolates {var} placeholders in an override the same way t() does", () => {
  const overrides = { "email.offer.subjectNoCity": "Order {orderName} ready {when}?" };
  assert.equal(
    tWithOverrides(overrides, "en", "email.offer.subjectNoCity", { orderName: "#42", when: "tomorrow" }),
    "Order #42 ready tomorrow?"
  );
});

test("tWithOverrides with empty overrides is byte-identical to calling t() directly", () => {
  for (const key of ["email.offer.greeting", "email.client.delivered.subject", "issueLabel.wrong_address"]) {
    assert.equal(tWithOverrides({}, "en", key), t("en", key));
  }
});

// ---- flattenKeys (runtime DB-override layer — the editor's + the write
// route's canonical key set) ----

test("flattenKeys lists every leaf dot-path of the EN catalog", () => {
  const keys = flattenKeys();
  assert.ok(keys.includes("email.shell.footer"));
  assert.ok(keys.includes("email.offer.subject"));
  assert.ok(keys.includes("email.client.delivered.photoNote"));
  assert.ok(keys.includes("issueLabel.missing_ingredient"));
  // Every listed key must actually resolve to a string leaf via t().
  for (const key of keys) {
    assert.equal(typeof t("en", key), "string");
    assert.notEqual(t("en", key), key); // t() only echoes the key back for a genuinely missing one
  }
});

test("flattenKeys never lists a branch, only leaves", () => {
  const keys = flattenKeys();
  assert.ok(!keys.includes("email"));
  assert.ok(!keys.includes("email.offer"));
  assert.ok(!keys.includes("issueLabel"));
});

// ---- staticLookup (per-locale lookup with NO cross-locale fallback) ----

test("staticLookup returns the EN value for a key EN has", () => {
  assert.equal(staticLookup("en", "email.shell.footer"), t("en", "email.shell.footer"));
});

test("staticLookup returns undefined (not the EN fallback) for a key EN has but the locale deliberately lacks", () => {
  // email.client.* stays English-only by design (see the analogous t() test
  // above, ~line 30) — EN has a real value here, so this proves staticLookup
  // does NOT fall back to it the way t() does.
  assert.equal(staticLookup("fr", "email.client.delivered.subject"), undefined);
  assert.equal(t("fr", "email.client.delivered.subject"), "Your Facundo order has been delivered");
});

test("ui.* keys resolve in every locale (spot check across the new florist-frontend catalog)", () => {
  const sample = [
    "ui.shell.nav.orders",
    "ui.account.language.title",
    "ui.account.language.fr",
  ];
  for (const key of sample) {
    for (const locale of LOCALES) {
      const value = t(locale, key);
      assert.notEqual(value, key, `${key} should resolve in ${locale}, not echo the key back`);
    }
  }
});

test("flattenKeys includes the new ui namespace alongside email/issueLabel", () => {
  const keys = flattenKeys();
  assert.ok(keys.some((k) => k.startsWith("ui.")));
  assert.ok(keys.includes("ui.account.language.title"));
});

// ---- key parity across locales (catches a key added to EN but forgotten in
// a locale — email.client.* is excluded because it stays English-only by
// design: customer-facing client emails are not translated) ----

test("every EN key outside email.client.* resolves in fr/es/it/de too", () => {
  const keys = flattenKeys().filter((k) => !k.startsWith("email.client."));
  const otherLocales = LOCALES.filter((l) => l !== "en");
  for (const locale of otherLocales) {
    for (const key of keys) {
      assert.notEqual(
        staticLookup(locale, key),
        undefined,
        `${key} is missing from locale "${locale}"`
      );
    }
  }
});

// ---- house style: no em dashes in outbound copy ----
// Removed deliberately (2026-08-05) from every florist-, customer- and
// staff-facing string. This guard is here because an em dash is easy to
// reintroduce by copy-paste and invisible in review at a glance — and on the
// SMS path it is not merely a style slip: U+2014 is outside GSM-7, so one of
// them silently flips a message to 67-char UCS-2 segments and doubles the bill.
//
// The original version matched `: "…",` on ONE line, which silently skipped
// every value long enough for the formatter to wrap onto its own line — and
// long values are exactly where an em dash hides. Two got through that way
// (ui.help.stillStuckBody, en + fr). It now walks the file character by
// character instead: comments are skipped (they may contain em dashes, and
// plenty deliberately do), and every string literal is checked however it is
// laid out.
/** Every double-quoted string literal in `src`, with comments skipped. */
function stringLiterals(src) {
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i === -1) break;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 1;
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      let value = "";
      i++;
      for (; i < src.length && src[i] !== quote; i++) {
        if (src[i] === "\\") {
          value += src[i + 1] ?? "";
          i++;
        } else value += src[i];
      }
      out.push(value);
    }
  }
  return out;
}

test("no catalog string contains an em dash, in any locale", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const dir = new URL("./messages/", import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 6, `expected every locale file, saw ${files.join(", ")}`);
  for (const file of files) {
    const src = await readFile(new URL(file, dir), "utf8");
    for (const value of stringLiterals(src)) {
      assert.ok(
        !value.includes("—"),
        `${file}: em dash in copy — use a comma, colon or full stop: ${value}`
      );
    }
  }
});

// Proves the walker sees what the old one-line regex missed, so this guard
// can't quietly regress to matching only short values again.
test("the em-dash scan reads wrapped values and ignores comments", () => {
  const src = [
    "// a comment with an em dash — allowed",
    "/* block comment — also allowed */",
    "export const x = {",
    '  short: "fine",',
    "  wrapped:",
    '    "a value long enough to sit on its own line — like the two that slipped through",',
    "};",
  ].join("\n");
  const values = stringLiterals(src);
  assert.deepEqual(values.filter((v) => v.includes("—")).length, 1);
  assert.ok(values.includes("fine"));
});

// WhatsApp is not a channel. OFFER_CHANNELS is ["email","sms","push"], and
// `florists.preferred_channel`/`whatsapp` are columns nothing reads. Promising
// it anywhere — the offer email, the recruiting funnel, or the join form —
// is a promise broken the first time a florist waits for a message that never
// arrives. This guard is catalog-WIDE on purpose: the first fix only covered
// the recruiting keys and left the same claim in the offer copy and the join
// form, in all six languages.
test("no message in any locale promises WhatsApp", () => {
  for (const locale of LOCALES) {
    for (const key of flattenKeys()) {
      const value = t(locale, key);
      assert.ok(
        !/whatsapp/i.test(value),
        `${locale}/${key} promises WhatsApp, which is not a channel we have: ${value}`
      );
    }
  }
});
