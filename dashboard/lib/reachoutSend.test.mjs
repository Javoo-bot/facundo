import test from "node:test";
import assert from "node:assert/strict";
// Imports from ./offerEmailContent.ts (not ./reachoutSend.ts): that file's
// implementation was factored out to a relative-imports-only sibling
// precisely so it's reachable here — reachoutSend.ts uses "@/..." aliases
// throughout (Supabase/push/etc), which plain `node --test` cannot resolve.
import {
  buildOfferEmailContent,
  recentAcceptedCutoffIso,
  formatOfferWhen,
  formatOfferReplyWindow,
  formatOfferDeliverBy,
} from "./offerEmailContent.ts";
import { LOCALES } from "./i18n/index.ts";

const NON_EN_LOCALES = LOCALES.filter((l) => l !== "en");

const baseVars = {
  area: "Girona · Catalonia",
  city: "Girona",
  orderName: "#1234",
  when: "today",
  replyWindow: "1 hour",
  deadlineTime: null,
  deliverBy: "21 Jul, 18:00",
  payoutPrice: 42,
  assignmentId: "test-assignment",
  orderUrl: "https://florist.fc.example.net/florist/m/9f8e7d6c-5b4a-4321-8765-0fedcba98765",
  testMode: true,
  floristName: "Floristería Test",
  unsubscribeUrl: "https://example.com/florist/unsubscribe/tok",
  howItWorksUrl: "https://example.com/florist/how-it-works",
  helpUrl: "https://example.com/help",
  supportEmail: "florists@fc.example.com",
};

test("recentAcceptedCutoffIso returns exactly 60 days before the given timestamp", () => {
  const now = Date.parse("2026-07-27T12:00:00.000Z");
  const cutoff = recentAcceptedCutoffIso(now);
  assert.equal(now - Date.parse(cutoff), 60 * 24 * 3600 * 1000);
});

// Both variants run the SAME four numbered steps; only the framing around them
// differs (full = introduction, short = a one-line reminder). These two tests
// pin that split, and that the old titled 5-step block stays out of the email.
test("buildOfferEmailContent full variant introduces Facundo and runs the four steps", () => {
  const { html, bodyText } = buildOfferEmailContent("en", {}, { ...baseVars, variant: "full" });
  assert.ok(html.includes("Hi there,"));
  assert.ok(html.includes("20-year legacy"));
  assert.ok(html.includes("70% immediately by credit card"));
  assert.ok(html.includes("remaining 30% before you deliver"));
  assert.ok(bodyText.includes("Hi there,"));
  // Plain-text alternative must carry the steps as a real numbered list.
  assert.ok(bodyText.includes("1. Click"), bodyText);
  assert.ok(bodyText.includes("4. Confirm the delivery"), bodyText);
  // The old titled step list must NOT come back into the email body.
  assert.ok(!html.includes("You accept the order"));
});

test("buildOfferEmailContent short variant swaps the introduction for a reminder, same four steps", () => {
  const { html } = buildOfferEmailContent("en", {}, { ...baseVars, variant: "short" });
  assert.ok(html.includes("Floristería Test"));
  assert.ok(!html.includes("Hi there,"));
  assert.ok(html.includes("Quick reminder in case it"), "short variant lost its reminder line");
  // Same four steps as the full variant — deliberately not a shortened email.
  assert.ok(html.includes("70% immediately by credit card"));
});

// The deadline sentence has two forms and must never render both.
test("buildOfferEmailContent states an absolute deadline when one is available", () => {
  const { html, bodyText } = buildOfferEmailContent("en", {}, { ...baseVars, variant: "full", deadlineTime: "18:30" });
  assert.ok(html.includes("We need your answer before 18:30."), html);
  assert.ok(!html.includes("within 1 hour"), "both deadline forms rendered");
  assert.ok(bodyText.includes("before 18:30"));
});

test("buildOfferEmailContent falls back to the countdown when there is no florist-local time", () => {
  const { html } = buildOfferEmailContent("en", {}, { ...baseVars, variant: "full", deadlineTime: null });
  assert.ok(html.includes("We need your answer within 1 hour."), html);
  assert.ok(!/before \d\d:\d\d/.test(html), "leaked an absolute time with no timezone");
});

test("buildOfferEmailContent always includes the unsubscribe and how-it-works links, in both variants", () => {
  for (const variant of ["full", "short"]) {
    const { html } = buildOfferEmailContent("en", {}, { ...baseVars, variant });
    // Unsubscribe is not optional — it is the only opt-out mechanism we offer.
    assert.ok(html.includes(baseVars.unsubscribeUrl), `${variant}: no unsubscribe link`);
    assert.ok(html.includes(baseVars.howItWorksUrl), `${variant}: no how-it-works link`);
    // The support line was removed on 2026-08-05 and deliberately restored on
    // 2026-09-16, when a florist's question bounced because the offer gave him
    // no address to write to (order #2000034). This assertion was flipped on
    // purpose, as the old one asked; if it ever goes again, flip it back the
    // same way.
    assert.ok(html.includes(`mailto:${baseVars.supportEmail}`), `${variant}: no support line`);
  }
});

test("buildOfferEmailContent gives the florist an address to write to, in every locale and both parts", () => {
  const leads = {
    en: "Questions about this order?", fr: "Une question sur cette commande ?",
    es: "¿Tienes alguna duda sobre este pedido?", it: "Domande su questo ordine?",
    de: "Fragen zu dieser Bestellung?", pt: "Dúvidas sobre esta encomenda?",
  };
  for (const [locale, lead] of Object.entries(leads)) {
    for (const variant of ["full", "short"]) {
      const { html, bodyText } = buildOfferEmailContent(locale, {}, { ...baseVars, variant });
      assert.ok(html.includes(`mailto:${baseVars.supportEmail}`), `${locale}/${variant}: html has no mailto`);
      // A text-only client must get the address too, not just a link it cannot see.
      assert.ok(bodyText.includes(baseVars.supportEmail), `${locale}/${variant}: text part has no address`);
      assert.ok(bodyText.includes(lead), `${locale}/${variant}: support lead not localized`);
    }
  }
});

test("buildOfferEmailContent keeps unsubscribe as the last footer line", () => {
  const { html, bodyText } = buildOfferEmailContent("en", {}, { ...baseVars, variant: "full" });
  assert.ok(html.lastIndexOf(baseVars.unsubscribeUrl) > html.lastIndexOf(`mailto:${baseVars.supportEmail}`));
  const lines = bodyText.trim().split(/\r?\n/);
  assert.ok(lines[lines.length - 1].includes(baseVars.unsubscribeUrl), lines.slice(-3).join(" | "));
});

// ---- formatOfferWhen / formatOfferReplyWindow / formatOfferDeliverBy ----
// Regression coverage for a confirmed production bug: these three phrases
// were hardcoded English literals spliced into an otherwise-localized offer
// email. A real Spanish send produced subject "¿puedes entregarlo today?" and
// body "Responde antes de 15 minutes". Every locale below is checked against
// an exact expected translation (not just "differs from English") so a wrong
// or missing translation fails loudly rather than silently falling back to EN.

test("formatOfferWhen renders the localized 'today' phrase when delivery_at is later the same local day", () => {
  const now = new Date("2026-07-27T10:00:00.000Z");
  const sameDay = new Date("2026-07-27T18:00:00.000Z").toISOString();
  const expected = { fr: "aujourd'hui", es: "hoy", it: "oggi", de: "heute", pt: "hoje" };
  for (const locale of NON_EN_LOCALES) {
    assert.equal(formatOfferWhen(locale, {}, sameDay, now), expected[locale]);
  }
  assert.equal(formatOfferWhen("en", {}, sameDay, now), "today");
});

test("formatOfferWhen renders the localized 'soon' phrase when delivery_at is missing entirely", () => {
  const now = new Date("2026-07-27T10:00:00.000Z");
  const expected = { fr: "bientôt", es: "pronto", it: "presto", de: "bald", pt: "em breve" };
  for (const locale of NON_EN_LOCALES) {
    assert.equal(formatOfferWhen(locale, {}, null, now), expected[locale]);
  }
  assert.equal(formatOfferWhen("en", {}, null, now), "soon");
});

test("formatOfferWhen renders a locale-aware short date (not the literal 'today'/'soon') when delivery_at is a different day", () => {
  const now = new Date("2026-07-27T10:00:00.000Z");
  const otherDay = new Date("2026-08-05T10:00:00.000Z");
  for (const locale of [...NON_EN_LOCALES, "en"]) {
    const out = formatOfferWhen(locale, {}, otherDay.toISOString(), now);
    assert.equal(out, otherDay.toLocaleDateString(locale, { day: "numeric", month: "short" }));
  }
});

test("formatOfferReplyWindow: <=1 minute left renders the localized 'a few minutes' phrase", () => {
  const nowMs = Date.parse("2026-07-27T10:00:00.000Z");
  const expiresAt = new Date(nowMs + 60_000).toISOString(); // exactly 1 minute
  const expected = { fr: "quelques minutes", es: "unos minutos", it: "qualche minuto", de: "ein paar Minuten", pt: "alguns minutos" };
  for (const locale of NON_EN_LOCALES) {
    assert.equal(formatOfferReplyWindow(locale, {}, expiresAt, nowMs), expected[locale]);
  }
  assert.equal(formatOfferReplyWindow("en", {}, expiresAt, nowMs), "a few minutes");
});

test("formatOfferReplyWindow: N minutes (plural) is localized with correct agreement", () => {
  const nowMs = Date.parse("2026-07-27T10:00:00.000Z");
  const expiresAt = new Date(nowMs + 5 * 60_000).toISOString();
  const expected = { fr: "5 minutes", es: "5 minutos", it: "5 minuti", de: "5 Minuten", pt: "5 minutos" };
  for (const locale of NON_EN_LOCALES) {
    assert.equal(formatOfferReplyWindow(locale, {}, expiresAt, nowMs), expected[locale]);
  }
  assert.equal(formatOfferReplyWindow("en", {}, expiresAt, nowMs), "5 minutes");
});

test("formatOfferReplyWindow: exactly 1 hour is localized in the singular", () => {
  const nowMs = Date.parse("2026-07-27T10:00:00.000Z");
  const expiresAt = new Date(nowMs + 60 * 60_000).toISOString();
  const expected = { fr: "1 heure", es: "1 hora", it: "1 ora", de: "1 Stunde", pt: "1 hora" };
  for (const locale of NON_EN_LOCALES) {
    assert.equal(formatOfferReplyWindow(locale, {}, expiresAt, nowMs), expected[locale]);
  }
  assert.equal(formatOfferReplyWindow("en", {}, expiresAt, nowMs), "1 hour");
});

test("formatOfferReplyWindow: N hours (plural) is localized with correct agreement", () => {
  const nowMs = Date.parse("2026-07-27T10:00:00.000Z");
  const expiresAt = new Date(nowMs + 2 * 3600_000).toISOString();
  const expected = { fr: "2 heures", es: "2 horas", it: "2 ore", de: "2 Stunden", pt: "2 horas" };
  for (const locale of NON_EN_LOCALES) {
    assert.equal(formatOfferReplyWindow(locale, {}, expiresAt, nowMs), expected[locale]);
  }
  assert.equal(formatOfferReplyWindow("en", {}, expiresAt, nowMs), "2 hours");
});

test("formatOfferReplyWindow: missing/already-past expiry falls back to the localized vague phrase", () => {
  const nowMs = Date.parse("2026-07-27T10:00:00.000Z");
  const expected = { fr: "quelques heures", es: "un par de horas", it: "un paio d'ore", de: "ein paar Stunden", pt: "algumas horas" };
  for (const locale of NON_EN_LOCALES) {
    assert.equal(formatOfferReplyWindow(locale, {}, new Date(nowMs - 1000).toISOString(), nowMs), expected[locale]);
    assert.equal(formatOfferReplyWindow(locale, {}, new Date(nowMs).toISOString(), nowMs), expected[locale]); // ms === 0
  }
  assert.equal(formatOfferReplyWindow("en", {}, new Date(nowMs - 1000).toISOString(), nowMs), "a couple of hours");
});

test("formatOfferDeliverBy: en resolves through the en-GB Intl locale (day-first, 24h), not bare en (month-first, 12h)", () => {
  const iso = "2026-07-21T18:00:00.000Z";
  const d = new Date(iso);
  const expectedEnGb = d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  const bareEn = d.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });
  assert.notEqual(expectedEnGb, bareEn); // sanity: en-GB and bare en really do differ in this runtime
  assert.equal(formatOfferDeliverBy("en", iso), expectedEnGb);
});

test("formatOfferDeliverBy is locale-aware for fr/es/it/de (matches direct Intl formatting for that locale, no hardcoded English month)", () => {
  const iso = "2026-07-21T18:00:00.000Z";
  const d = new Date(iso);
  for (const locale of NON_EN_LOCALES) {
    const expected = d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
    const out = formatOfferDeliverBy(locale, iso);
    assert.equal(out, expected);
    assert.ok(!/\bJul\b/.test(out), `${locale} deliverBy leaked the English month abbreviation: ${out}`);
  }
});

test("formatOfferDeliverBy returns null for a missing or invalid iso", () => {
  assert.equal(formatOfferDeliverBy("en", null), null);
  assert.equal(formatOfferDeliverBy("en", undefined), null);
  assert.equal(formatOfferDeliverBy("en", "not-a-date"), null);
});

// ---- overrides (tWithOverrides) still take precedence ----
// A DB override for a when/replyWindow catalog key must win over the built-in
// translation, in every locale — exercises the same tWithOverrides seam the
// rest of the offer email uses, so an editor-saved override actually shows up
// in these three phrases too (not just the surrounding boilerplate copy).

test("formatOfferWhen: an override for when.today/when.soon wins over the catalog, in every locale", () => {
  const overrides = { "email.offer.when.today": "AUJOURD'HUI OVERRIDDEN", "email.offer.when.soon": "SOON OVERRIDDEN" };
  const now = new Date("2026-07-27T10:00:00.000Z");
  const sameDay = new Date("2026-07-27T18:00:00.000Z").toISOString();
  for (const locale of [...NON_EN_LOCALES, "en"]) {
    assert.equal(formatOfferWhen(locale, overrides, sameDay, now), "AUJOURD'HUI OVERRIDDEN");
    assert.equal(formatOfferWhen(locale, overrides, null, now), "SOON OVERRIDDEN");
  }
});

test("formatOfferReplyWindow: an override for each replyWindow bucket wins over the catalog, in every locale", () => {
  const nowMs = Date.parse("2026-07-27T10:00:00.000Z");
  const overrides = {
    "email.offer.replyWindow.fewMinutes": "FEW-OVERRIDE",
    "email.offer.replyWindow.minutes": "{count}-MIN-OVERRIDE",
    "email.offer.replyWindow.hour": "HOUR-OVERRIDE",
    "email.offer.replyWindow.hours": "{count}-HOURS-OVERRIDE",
    "email.offer.replyWindow.couple": "COUPLE-OVERRIDE",
  };
  for (const locale of [...NON_EN_LOCALES, "en"]) {
    assert.equal(formatOfferReplyWindow(locale, overrides, new Date(nowMs + 60_000).toISOString(), nowMs), "FEW-OVERRIDE");
    assert.equal(formatOfferReplyWindow(locale, overrides, new Date(nowMs + 5 * 60_000).toISOString(), nowMs), "5-MIN-OVERRIDE");
    assert.equal(formatOfferReplyWindow(locale, overrides, new Date(nowMs + 60 * 60_000).toISOString(), nowMs), "HOUR-OVERRIDE");
    assert.equal(formatOfferReplyWindow(locale, overrides, new Date(nowMs + 2 * 3600_000).toISOString(), nowMs), "2-HOURS-OVERRIDE");
    assert.equal(formatOfferReplyWindow(locale, overrides, new Date(nowMs - 1000).toISOString(), nowMs), "COUPLE-OVERRIDE");
  }
});

// ---- formatOfferReplyWindow: plural/rounding boundaries ----
// The bucket switch (mins<60 vs hours) and the fewMinutes/plural-minutes split
// (mins<=1) are both exact-integer comparisons on a *rounded* minute count —
// worth pinning the boundary values directly rather than trusting the
// mid-bucket examples above to catch an off-by-one.

test("formatOfferReplyWindow: exactly 2 minutes uses the plural-minutes bucket, not fewMinutes", () => {
  const nowMs = Date.parse("2026-07-27T10:00:00.000Z");
  const expiresAt = new Date(nowMs + 2 * 60_000).toISOString();
  assert.equal(formatOfferReplyWindow("en", {}, expiresAt, nowMs), "2 minutes");
  assert.equal(formatOfferReplyWindow("fr", {}, expiresAt, nowMs), "2 minutes");
});

test("formatOfferReplyWindow: 59 minutes stays in the minutes bucket (does not round up to an hour)", () => {
  const nowMs = Date.parse("2026-07-27T10:00:00.000Z");
  const expiresAt = new Date(nowMs + 59 * 60_000).toISOString();
  assert.equal(formatOfferReplyWindow("en", {}, expiresAt, nowMs), "59 minutes");
});

test("formatOfferReplyWindow: 61 minutes rounds DOWN to '1 hour' (Math.round(61/60) === 1)", () => {
  const nowMs = Date.parse("2026-07-27T10:00:00.000Z");
  const expiresAt = new Date(nowMs + 61 * 60_000).toISOString();
  assert.equal(formatOfferReplyWindow("en", {}, expiresAt, nowMs), "1 hour");
});

test("formatOfferReplyWindow: 89 minutes still rounds to '1 hour'; 90 minutes rounds UP to '2 hours' (round-half-up)", () => {
  const nowMs = Date.parse("2026-07-27T10:00:00.000Z");
  assert.equal(formatOfferReplyWindow("en", {}, new Date(nowMs + 89 * 60_000).toISOString(), nowMs), "1 hour");
  assert.equal(formatOfferReplyWindow("en", {}, new Date(nowMs + 90 * 60_000).toISOString(), nowMs), "2 hours");
});

test("formatOfferReplyWindow: an unparseable expiry (NaN ms) falls back to the vague phrase rather than 'NaN minutes'", () => {
  const nowMs = Date.parse("2026-07-27T10:00:00.000Z");
  assert.equal(formatOfferReplyWindow("en", {}, "not-a-date", nowMs), "a couple of hours");
  assert.equal(formatOfferReplyWindow("fr", {}, "not-a-date", nowMs), "quelques heures");
});

// ---- fr carve-out narrowness ----
// The leak guard below deliberately exempts French "minute"/"minutes" (a real
// French word, not a leak). Confirm that carve-out is scoped to exactly those
// two tokens and doesn't accidentally swallow a genuine leak of any other
// banned token in French text.

test("fr carve-out narrowness: only minute/minutes are exempted for French — a leaked today/soon/hour/couple still trips the guard", () => {
  assert.deepEqual(leakedEnglishTokens("Réponds dans 5 minutes", "fr"), []); // real fr word, correctly exempted
  assert.deepEqual(leakedEnglishTokens("Livraison today", "fr"), ["today"]);
  assert.deepEqual(leakedEnglishTokens("à bientôt, see you soon", "fr"), ["soon"]);
  assert.deepEqual(leakedEnglishTokens("dans environ 1 hour", "fr"), ["hour"]);
  assert.deepEqual(leakedEnglishTokens("dans 2 hours environ", "fr"), ["hours"]);
  assert.deepEqual(leakedEnglishTokens("a few de choses", "fr"), ["a few"]);
  assert.deepEqual(leakedEnglishTokens("a couple de choses", "fr"), ["a couple"]);
});

// ---- Leak guard ----
// The point of this exercise: it must fail if someone re-introduces a
// hardcoded English string into the offer email's when/replyWindow phrases.
// Word-boundary regexes so a token can't false-positive as a substring of a
// longer, unrelated word. One deliberate carve-out: French "minute"/"minutes"
// is a genuine French word spelled identically to English (a real cognate,
// not a leak) — every other locale/token pair is clean, confirmed by scanning
// every translated phrase against this exact token list.
// "your area" and "there" cover the two fixed leaks: the old hardcoded
// `introCity = city ?? "your area"` fallback (now email.offer.introNoCity)
// and the old hardcoded `floristName: ... ?? "there"` fallback (now
// email.offer.genericFloristName) — see the tests below that force both
// fallbacks to fire in every non-EN locale.
const BANNED_EN_TOKENS = ["today", "soon", "minutes", "minute", "hours", "hour", "a few", "a couple", "your area", "there"];

function leakedEnglishTokens(text, locale) {
  const exempt = locale === "fr" ? new Set(["minute", "minutes"]) : new Set();
  return BANNED_EN_TOKENS.filter((tok) => !exempt.has(tok)).filter((tok) => new RegExp(`\\b${tok}\\b`, "i").test(text));
}

test("leak guard: full offer email in each non-EN locale never contains a hardcoded English when/replyWindow literal", () => {
  const nowMs = Date.parse("2026-07-27T10:00:00.000Z");
  const now = new Date(nowMs);
  // Every reply-window bucket plus the "soon"/expired branch, so a leak in
  // any one branch is caught, not just the branch a hand-picked example hits.
  const cases = [
    ["today + a-few-minutes", new Date(nowMs + 3600_000).toISOString(), new Date(nowMs + 60_000).toISOString()],
    ["today + N minutes", new Date(nowMs + 3600_000).toISOString(), new Date(nowMs + 5 * 60_000).toISOString()],
    ["today + exactly 1 hour", new Date(nowMs + 3600_000).toISOString(), new Date(nowMs + 60 * 60_000).toISOString()],
    ["today + N hours", new Date(nowMs + 3600_000).toISOString(), new Date(nowMs + 2 * 3600_000).toISOString()],
    ["soon (no delivery_at) + already-expired", null, new Date(nowMs - 1000).toISOString()],
  ];
  for (const locale of NON_EN_LOCALES) {
    for (const variant of ["full", "short"]) {
      for (const [label, deliveryAtIso, expiresAtIso] of cases) {
        const when = formatOfferWhen(locale, {}, deliveryAtIso, now);
        const replyWindow = formatOfferReplyWindow(locale, {}, expiresAtIso, nowMs);
        const deliverBy = formatOfferDeliverBy(locale, deliveryAtIso);
        const { subject, bodyText, html } = buildOfferEmailContent(locale, {}, {
          ...baseVars,
          when,
          replyWindow,
          deliverBy,
          variant,
        });
        const leaked = leakedEnglishTokens(`${subject}\n${bodyText}\n${html}`, locale);
        assert.deepEqual(leaked, [], `${locale}/${variant}/${label} leaked English tokens: ${leaked.join(", ")}`);
      }
    }
  }
});

// Regression coverage for a second confirmed production bug (same class as
// the one above, found in the same QA pass): `city: null` (delivery_area
// missing) spliced the hardcoded English "your area" into the translated
// `email.offer.intro` sentence, and a missing florist name spliced the
// hardcoded English "there" into the short-variant greeting. Both fixtures
// below always supplied city/floristName, which is exactly why the first
// leak-guard pass didn't catch either — this test deliberately omits them.
test("leak guard: city: null (no delivery_area) never leaks 'your area' into a non-EN intro", () => {
  // baseVars.when/replyWindow are themselves hardcoded English literals (a
  // fixture convenience for tests that aren't exercising those two fields) —
  // localize them per-locale here, exactly like the leak-guard test above,
  // so this test isn't flagging its OWN fixture's English strings.
  const nowMs = Date.parse("2026-07-27T10:00:00.000Z");
  for (const locale of NON_EN_LOCALES) {
    const when = formatOfferWhen(locale, {}, null, new Date(nowMs));
    const replyWindow = formatOfferReplyWindow(locale, {}, new Date(nowMs + 3600_000).toISOString(), nowMs);
    for (const variant of ["full", "short"]) {
      const { subject, bodyText, html } = buildOfferEmailContent(locale, {}, {
        ...baseVars,
        area: null,
        city: null,
        when,
        replyWindow,
        variant,
      });
      const leaked = leakedEnglishTokens(`${subject}\n${bodyText}\n${html}`, locale);
      assert.deepEqual(leaked, [], `${locale}/${variant} (city:null) leaked English tokens: ${leaked.join(", ")}`);
    }
  }
});

test("leak guard: floristName absent/null never leaks 'there' into the non-EN short-variant greeting", () => {
  const nowMs = Date.parse("2026-07-27T10:00:00.000Z");
  for (const locale of NON_EN_LOCALES) {
    const when = formatOfferWhen(locale, {}, null, new Date(nowMs));
    const replyWindow = formatOfferReplyWindow(locale, {}, new Date(nowMs + 3600_000).toISOString(), nowMs);
    for (const floristName of [null, undefined]) {
      const { subject, bodyText, html } = buildOfferEmailContent(locale, {}, {
        ...baseVars,
        floristName,
        when,
        replyWindow,
        variant: "short",
      });
      const leaked = leakedEnglishTokens(`${subject}\n${bodyText}\n${html}`, locale);
      assert.deepEqual(leaked, [], `${locale}/short (floristName:${floristName}) leaked English tokens: ${leaked.join(", ")}`);
    }
  }
});

test("leak guard: city: null AND floristName: null together, across every reply-window bucket, never leaks in any non-EN locale", () => {
  const nowMs = Date.parse("2026-07-27T10:00:00.000Z");
  const now = new Date(nowMs);
  const cases = [
    ["today + a-few-minutes", new Date(nowMs + 3600_000).toISOString(), new Date(nowMs + 60_000).toISOString()],
    ["soon (no delivery_at) + already-expired", null, new Date(nowMs - 1000).toISOString()],
  ];
  for (const locale of NON_EN_LOCALES) {
    for (const variant of ["full", "short"]) {
      for (const [label, deliveryAtIso, expiresAtIso] of cases) {
        const when = formatOfferWhen(locale, {}, deliveryAtIso, now);
        const replyWindow = formatOfferReplyWindow(locale, {}, expiresAtIso, nowMs);
        const deliverBy = formatOfferDeliverBy(locale, deliveryAtIso);
        const { subject, bodyText, html } = buildOfferEmailContent(locale, {}, {
          ...baseVars,
          area: null,
          city: null,
          floristName: null,
          when,
          replyWindow,
          deliverBy,
          variant,
        });
        const leaked = leakedEnglishTokens(`${subject}\n${bodyText}\n${html}`, locale);
        assert.deepEqual(leaked, [], `${locale}/${variant}/${label} (city+floristName null) leaked English tokens: ${leaked.join(", ")}`);
      }
    }
  }
});

// The offer email's CTA (and its plain-text twin) must be the one-click
// sign-in link, not the bare /florist/orders/<id> path. That path hit the auth
// redirect in app/florist/(app)/layout.tsx, LOST the order, and left the
// florist on the home screen — the whole reason magic links exist.
test("the offer email links to the magic sign-in URL, never a bare order path", () => {
  for (const locale of LOCALES) {
    for (const variant of ["full", "short"]) {
      const { html, bodyText } = buildOfferEmailContent(locale, {}, { ...baseVars, variant });
      assert.ok(html.includes(`href="${baseVars.orderUrl}"`), `${locale}/${variant}: CTA href is not the magic URL`);
      assert.ok(bodyText.includes(baseVars.orderUrl), `${locale}/${variant}: plain text carries no order link`);
      assert.ok(!html.includes("/florist/orders/"), `${locale}/${variant}: bare order path leaked into html`);
      assert.ok(!bodyText.includes("/florist/orders/"), `${locale}/${variant}: bare order path leaked into text`);
    }
  }
});
