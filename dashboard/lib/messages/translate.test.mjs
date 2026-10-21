import test from "node:test";
import assert from "node:assert/strict";
import {
  checkTranslation,
  judgeTranslations,
  buildTranslationPrompt,
  parseTranslationReply,
  isSmsKey,
} from "./translate.ts";

test("a clean translation passes", () => {
  assert.deepEqual(checkTranslation("email.offer.greeting", "Hi there,", "Bonjour,"), []);
});

// The guards, each one for a failure that costs money or breaks a real send.

test("a lost placeholder is rejected, and named", () => {
  const reasons = checkTranslation(
    "email.offer.intro",
    "We're expanding in {city}, and your reviews are why.",
    "Nous nous developpons, et vos avis sont la raison."
  );
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /\{city\}/);
});

test("a placeholder the send site needs is caught even when the source omits it", () => {
  // varsManifest knows sms.offer.optOut takes {url}; a translation without it
  // would send a florist an opt-out line with no link, which is the one thing
  // that keeps the sends compliant.
  const reasons = checkTranslation("sms.offer.optOut", "Stop texts:", "Parar SMS:");
  assert.ok(reasons.some((r) => r.includes("{url}")), reasons.join(" | "));
});

test("an em dash is rejected", () => {
  const reasons = checkTranslation("email.offer.greeting", "Hi there,", "Bonjour — bonjour,");
  assert.ok(reasons.some((r) => /em dash/i.test(r)));
});

test("a non-GSM-7 SMS translation is rejected, with the cost spelled out", () => {
  // A CURLY apostrophe, not an accent: ñ/é/à are all inside GSM-7 (see
  // smsSegments.test.mjs), whereas ’ is not — and it is exactly what a model
  // produces when it tidies up "n'est" or "l'ordine".
  const reasons = checkTranslation("sms.offer.body", "Order in {city}: {url} {deadline}", "Commande a {city}, c’est pret: {url} {deadline}");
  assert.ok(reasons.some((r) => /GSM-7/.test(r) && /double/i.test(r)), reasons.join(" | "));
});

test("genuinely GSM-7 accents are NOT rejected on an SMS key", () => {
  // Rejecting every accent would be wrong: ñ and é cost nothing extra.
  assert.deepEqual(
    checkTranslation(
      "sms.offer.body",
      "Order in {city}: {url} {deadline}",
      "Pedido en {city}, mañana: {url} {deadline}"
    ),
    []
  );
});

test("the same non-GSM-7 text is fine on an EMAIL key", () => {
  // Only SMS pays per segment; policing typography in email would be absurd.
  assert.deepEqual(checkTranslation("email.offer.greeting", "Hi there,", "¡Hola señor, c’est prêt!"), []);
});

test("an over-budget SMS string is rejected", () => {
  const long = "a".repeat(500);
  const reasons = checkTranslation("sms.offer.body", "short {url} {deadline} {city}", `${long} {url} {deadline} {city}`);
  assert.ok(reasons.some((r) => /segments/.test(r)), reasons.join(" | "));
});

test("an empty translation is rejected", () => {
  assert.deepEqual(checkTranslation("email.offer.greeting", "Hi,", "   "), ["Empty translation."]);
});

test("judgeTranslations marks each candidate independently", () => {
  const v = judgeTranslations("email.offer.intro", "Hi {city}", [
    { locale: "fr", value: "Bonjour {city}" },
    { locale: "es", value: "Hola" },
  ]);
  assert.equal(v[0].ok, true);
  assert.equal(v[1].ok, false);
  assert.ok(v[1].reasons[0].includes("{city}"));
});

test("isSmsKey only matches the SMS namespace", () => {
  assert.ok(isSmsKey("sms.offer.body"));
  assert.ok(!isSmsKey("email.offer.intro"));
});

// ---- prompt + parsing ----

test("the prompt names the placeholders that must survive, and the SMS rule only for SMS", () => {
  const p = buildTranslationPrompt("sms.offer.body", "Order in {city}: {url}", ["fr", "de"]);
  assert.ok(p.includes("{city}"));
  assert.ok(p.includes("{url}"));
  assert.ok(/GSM-7/.test(p));
  assert.ok(p.includes("French") && p.includes("German"));

  const e = buildTranslationPrompt("email.offer.greeting", "Hi there,", ["fr"]);
  assert.ok(!/GSM-7/.test(e), "email prompt should not carry the SMS rule");
  assert.ok(/no placeholders/i.test(e));
});

test("parseTranslationReply reads a plain object and tolerates a code fence", () => {
  assert.deepEqual(parseTranslationReply('{"fr":"Bonjour","es":"Hola"}', ["fr", "es"]), [
    { locale: "fr", value: "Bonjour" },
    { locale: "es", value: "Hola" },
  ]);
  assert.deepEqual(parseTranslationReply('```json\n{"fr":"Bonjour"}\n```', ["fr"]), [
    { locale: "fr", value: "Bonjour" },
  ]);
});

test("parseTranslationReply returns nothing it can't read, rather than guessing", () => {
  assert.deepEqual(parseTranslationReply("sorry, I can't do that", ["fr"]), []);
  assert.deepEqual(parseTranslationReply("[1,2,3]", ["fr"]), []);
  assert.deepEqual(parseTranslationReply('{"fr": 42}', ["fr"]), []);
  // A locale the caller didn't ask for is ignored.
  assert.deepEqual(parseTranslationReply('{"fr":"Bonjour","zz":"x"}', ["fr"]), [{ locale: "fr", value: "Bonjour" }]);
});
