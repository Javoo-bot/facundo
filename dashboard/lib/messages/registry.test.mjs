import test from "node:test";
import assert from "node:assert/strict";
import { MESSAGES, messageById } from "./registry.ts";
import { previewOverrides, tagPreviewHtml, stripSentinels, keysInOrder, hasSentinel } from "./previewTags.ts";
import { LOCALES } from "../i18n/index.ts";
import { smsSegments, isGsm7 } from "../smsSegments.ts";

test("message ids are unique and resolvable", () => {
  const ids = MESSAGES.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate message id");
  for (const id of ids) assert.ok(messageById(id), id);
  assert.equal(messageById("nope.not.real"), undefined);
});

test("every message renders in every locale it claims to support", () => {
  for (const m of MESSAGES) {
    const locales = m.localized ? LOCALES : ["en"];
    for (const locale of locales) {
      const out = m.render(locale, {});
      assert.equal(typeof out.subject, "string", `${m.id}/${locale} subject`);
      assert.equal(typeof out.html, "string", `${m.id}/${locale} html`);
      assert.ok(out.bodyText.length > 0, `${m.id}/${locale} empty body`);
      // A leaked "{placeholder}" means the registry's sample data is missing a
      // var the builder expects — the preview would show a raw token.
      assert.ok(!/\{[a-zA-Z]\w*\}/.test(out.bodyText), `${m.id}/${locale} unreplaced placeholder: ${out.bodyText}`);
      assert.ok(!/\{[a-zA-Z]\w*\}/.test(out.subject), `${m.id}/${locale} unreplaced placeholder in subject`);
    }
  }
});

test("every email message produces HTML; SMS produces text only", () => {
  for (const m of MESSAGES) {
    // The recruiting funnel's builders return CONTENT, not a finished email —
    // the shell (and therefore the branded/plain voice) is applied by the
    // sender, so there is no single HTML rendering to assert here. Every other
    // email builder calls renderEmailShell itself and must produce markup.
    if (m.channel === "email" && !m.id.startsWith("recruit.") && !m.id.startsWith("reactivate.")) {
      assert.ok(m.render("en", {}).html.includes("<"), `${m.id} produced no HTML`);
    }
    if (m.channel === "sms") assert.equal(m.render("en", {}).html, "", `${m.id} should be text-only`);
  }
});

// The point of the registry: everything is previewable AND every rendered
// string traces back to a key the editor can offer as a field.
test("every message exposes at least one editable key through the preview tagger", () => {
  for (const m of MESSAGES) {
    const o = previewOverrides({}, "en");
    const out = m.render("en", o);
    const keys = keysInOrder(out.html + out.subject + out.bodyText);
    assert.ok(keys.length > 0, `${m.id} exposed no editable keys`);
    for (const k of keys) assert.match(k, /^[a-zA-Z][\w.]*$/, `${m.id} produced a strange key: ${k}`);
  }
});

test("tagged HTML is clean, and the plain-text parts strip back to the real copy", () => {
  for (const m of MESSAGES) {
    const o = previewOverrides({}, "en");
    const out = m.render("en", o);
    const tagged = tagPreviewHtml(out.html);
    assert.ok(!hasSentinel(tagged), `${m.id} leaked a marker into tagged HTML`);
    const plain = stripSentinels(out.bodyText);
    assert.ok(!hasSentinel(plain), `${m.id} leaked a marker into plain text`);
    // Stripping markers must reproduce exactly what a real send would produce.
    assert.equal(plain, m.render("en", {}).bodyText, `${m.id} preview text differs from a real send`);
    assert.equal(stripSentinels(out.subject), m.render("en", {}).subject, `${m.id} preview subject differs`);
  }
});

test("an edit passed through the preview actually changes what renders", () => {
  const o = previewOverrides({ "email.offer.greeting": "SALUT," }, "en");
  const { html } = messageById("offer.full").render("en", o);
  assert.ok(stripSentinels(html).includes("SALUT,"));
});

test("the SMS messages stay inside their segment budget from the registry's own sample data", () => {
  for (const m of MESSAGES.filter((x) => x.channel === "sms")) {
    for (const locale of LOCALES) {
      const body = m.render(locale, {}).bodyText;
      assert.ok(isGsm7(body), `${m.id}/${locale} is not GSM-7: ${body}`);
      assert.ok(smsSegments(body) <= 3, `${m.id}/${locale} is ${smsSegments(body)} segments`);
    }
  }
});

test("every message's declared variables actually appear in what it renders, or are documented as optional", () => {
  // The editor offers these as insertable tokens. A variable the send site
  // never interpolates would render as a literal "{payout}" to a florist, so
  // each one must at least be a var the message's builder knows about.
  for (const m of MESSAGES) {
    for (const v of m.variables) {
      assert.match(v.name, /^[a-zA-Z]\w*$/, `${m.id}: odd variable name ${v.name}`);
      assert.ok(v.example.length > 0, `${m.id}/${v.name} has no example`);
      assert.ok(v.what.length > 10, `${m.id}/${v.name} has no explanation`);
    }
    const names = m.variables.map((v) => v.name);
    assert.equal(new Set(names).size, names.length, `${m.id} lists a variable twice`);
  }
});

test("a message only offers variables that are in scope for it", () => {
  // {payout} is meaningless in a recruiting email; offering it there invites
  // copy that renders as a literal token.
  for (const id of ["recruit.t1", "recruit.t2", "recruit.t3", "recruit.r1", "recruit.r2", "recruit.co1", "recruit.co2"]) {
    const recruiting = messageById(id).variables.map((v) => v.name);
    assert.ok(!recruiting.includes("payout"), `${id}: ${recruiting.join(",")}`);
    assert.ok(!recruiting.includes("orderName"), id);
    assert.ok(recruiting.includes("city"), id);
  }

  // Customer and internal mail interpolate nothing editable.
  assert.deepEqual(messageById("client.assigned").variables, []);
  assert.deepEqual(messageById("testEmail").variables, []);
});

test("every email in the catalog renders actual HTML", () => {
  // Reported 2026-09-03: opening a cold-reach-out message on /flows showed a
  // blank frame. The seven recruiting touches (and the four reactivation
  // ones) returned `html: ""` — they had never had a rendered preview, which
  // went unnoticed on /messages because the raw-key panel is the way in
  // there. On a screen with no key panel there was nothing to edit at all.
  for (const m of MESSAGES) {
    if (m.channel !== "email") continue;
    const built = m.render("en", {});
    assert.ok(built.html.length > 0, `${m.id} renders no HTML`);
    assert.ok(built.subject.length > 0, `${m.id} renders no subject`);
  }
});
