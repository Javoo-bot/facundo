import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, renderParagraphs, renderEmailShell, renderFactsBlock, renderHeadline, renderLinkLine } from "./emailTemplate.ts";
import { tWithOverrides } from "./i18n/index.ts";

test("escapeHtml escapes the five HTML-significant characters", () => {
  assert.equal(escapeHtml(`<b>"Tom & Jerry's" show</b>`), "&lt;b&gt;&quot;Tom &amp; Jerry&#39;s&quot; show&lt;/b&gt;");
});

test("renderParagraphs splits on blank lines into separate <p> tags and escapes content", () => {
  const html = renderParagraphs("Hi <there>\n\nSecond paragraph & more");
  const matches = html.match(/<p /g) ?? [];
  assert.equal(matches.length, 2);
  assert.ok(html.includes("Hi &lt;there&gt;"));
  assert.ok(html.includes("Second paragraph &amp; more"));
  assert.ok(!html.includes("<there>"));
});

test("renderParagraphs turns single newlines into <br />", () => {
  const html = renderParagraphs("line one\nline two");
  assert.ok(html.includes("line one<br />line two"));
});

test("renderEmailShell includes the test-mode banner only when testMode is true", () => {
  const withBanner = renderEmailShell("<p>hi</p>", { testMode: true });
  assert.ok(withBanner.includes("TEST MODE"));
  const withoutBanner = renderEmailShell("<p>hi</p>", { testMode: false });
  assert.ok(!withoutBanner.includes("TEST MODE"));
  const defaultCase = renderEmailShell("<p>hi</p>");
  assert.ok(!defaultCase.includes("TEST MODE"));
});

test("renderEmailShell renders the CTA button with an escaped href and label when given", () => {
  const html = renderEmailShell("<p>hi</p>", { cta: { label: "View & respond", url: "https://example.com/a?b=1&c=2" } });
  assert.ok(html.includes("View &amp; respond"));
  assert.ok(html.includes("https://example.com/a?b=1&amp;c=2"));
});

test("renderEmailShell omits the CTA table when no cta is given", () => {
  const html = renderEmailShell("<p>hi</p>");
  assert.ok(!html.includes('href="'));
});

test("renderEmailShell embeds the content HTML verbatim and always includes the footer line", () => {
  const html = renderEmailShell("<p>MARKER-CONTENT</p>");
  assert.ok(html.includes("MARKER-CONTENT"));
  assert.ok(html.includes("Facundo"));
  assert.ok(html.toLowerCase().includes("automated message"));
});

test("renderEmailShell's header renders the logo image, not the old icon+text combo", () => {
  const html = renderEmailShell("<p>hi</p>");
  assert.ok(html.includes("facundo-logo-email.png"));
  assert.ok(!html.includes("facundo-mark.png"));
  assert.ok(!html.includes(">Facundo<"));
});

test("renderLinkLine escapes lead-in text, label, and url, and embeds an <a> tag", () => {
  const html = renderLinkLine("Prefer <not> this?", "Manage & stop", "https://example.com/a?b=1&c=2");
  assert.ok(html.includes("Prefer &lt;not&gt; this?"));
  assert.ok(html.includes(">Manage &amp; stop<"));
  assert.ok(html.includes('href="https://example.com/a?b=1&amp;c=2"'));
  assert.ok(!html.includes("<not>"));
});

test("renderEmailShell includes the hidden preheader text when given, and omits it otherwise", () => {
  const withPre = renderEmailShell("<p>hi</p>", { preheader: "Sneak peek text" });
  assert.ok(withPre.includes("Sneak peek text"));
  const withoutPre = renderEmailShell("<p>hi</p>");
  assert.ok(!withoutPre.includes("display:none"));
});

test("renderFactsBlock renders one row per fact, escaped, label left / value right", () => {
  const html = renderFactsBlock([
    { label: "Payout", value: "€12" },
    { label: "Area", value: "Downtown & Riverside" },
  ]);
  assert.ok(html.includes("Payout"));
  assert.ok(html.includes("€12"));
  assert.ok(html.includes("Downtown &amp; Riverside"));
  assert.equal((html.match(/<tr>/g) ?? []).length, 2);
});

test("renderFactsBlock returns an empty string for no facts (nothing to show)", () => {
  assert.equal(renderFactsBlock([]), "");
});

test("renderHeadline escapes its text", () => {
  const html = renderHeadline("<script>alert(1)</script>");
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("renderEmailShell applies an override for the test banner and footer, and escapes it", () => {
  const overridden = renderEmailShell("<p>hi</p>", {
    testMode: true,
    overrides: {
      "email.shell.testBanner": "CUSTOM BANNER <b>markup</b>",
      "email.shell.footer": "Custom footer & more",
    },
  });
  assert.ok(overridden.includes("CUSTOM BANNER &lt;b&gt;markup&lt;/b&gt;"));
  assert.ok(!overridden.includes("<b>markup</b>"));
  assert.ok(overridden.includes("Custom footer &amp; more"));

  // No overrides passed (default {}) is byte-identical to the old plain-t() shell.
  const withBanner = renderEmailShell("<p>hi</p>", { testMode: true });
  assert.ok(withBanner.includes("TEST MODE"));
  const plainFooter = renderEmailShell("<p>hi</p>");
  assert.ok(plainFooter.toLowerCase().includes("automated message"));
});

test("a staff-entered message override containing markup is escaped, not injected as HTML (regression: lib/clientComms.ts delivered-photo caption, stored XSS)", () => {
  // Mirrors the exact pattern clientComms.ts's deliveredPhotoHtml() now uses:
  // escapeHtml(tWithOverrides(overrides, locale, key)) instead of interpolating
  // the override raw into the template literal.
  const overrides = { "email.client.delivered.photoNote": '<img src=x onerror="alert(document.cookie)">' };
  const rendered = escapeHtml(tWithOverrides(overrides, "en", "email.client.delivered.photoNote"));
  assert.ok(!rendered.includes("<img"));
  assert.ok(rendered.includes("&lt;img"));
  assert.ok(!rendered.includes("onerror=\"alert"));
});

// ---- the plain voice ----
// An email that reads as though a person typed it. What it drops is chrome;
// what it must NOT drop is the safety banner and the legal footer.

const PLAIN = { voice: "plain" };

test("the plain voice drops the logo, the card and the CTA button", () => {
  const html = renderEmailShell("<p>hello</p>", {
    ...PLAIN,
    cta: { label: "Join", url: "https://example.com/join" },
  });
  assert.ok(!html.includes("<img"), "plain voice rendered an image");
  assert.ok(!/facundo-logo-email\.png/.test(html), "plain voice rendered the logo");
  assert.ok(!html.includes("bgcolor"), "plain voice rendered a coloured cell");
  assert.ok(!html.includes("<table"), "plain voice rendered table chrome");
  assert.ok(!html.includes("#1F7A55"), "plain voice used the brand green");
});

test("the plain voice degrades the CTA to an inline link, never losing it", () => {
  const html = renderEmailShell("<p>hello</p>", {
    ...PLAIN,
    cta: { label: "Join the network", url: "https://example.com/join?a=1&b=2" },
  });
  assert.ok(html.includes("https://example.com/join?a=1&amp;b=2"), "lost or unescaped the CTA url");
  assert.ok(html.includes("Join the network"), "lost the CTA label");
});

// app_settings.test_mode defaults to TRUE. A redirected test send that looks
// identical to a real one is exactly what this banner exists to prevent, and
// the plain voice does not get to drop it for looking tidier.
test("the plain voice STILL renders the test-mode banner", () => {
  const on = renderEmailShell("<p>hi</p>", { ...PLAIN, testMode: true });
  assert.ok(on.includes("TEST MODE"), "plain voice swallowed the test banner");
  const off = renderEmailShell("<p>hi</p>", { ...PLAIN, testMode: false });
  assert.ok(!off.includes("TEST MODE"));
});

// Commercial mail into DE (Impressum) and FR (mentions légales) needs an
// identifiable sender and a way out, hand-written look or not.
test("the plain voice keeps an identifiable sender and an unsubscribe path", () => {
  const html = renderEmailShell("<p>hi</p>", {
    ...PLAIN,
    unsubscribeUrl: "https://example.com/unsub/abc",
  });
  assert.ok(html.includes("Facundo"), "plain voice has no identifiable sender");
  assert.ok(html.includes("https://example.com/unsub/abc"), "plain voice has no way out");
});

test("the plain voice renders the persona signature", () => {
  const html = renderEmailShell("<p>hi</p>", {
    ...PLAIN,
    signature: { name: "Marta Ruiz", roleTitle: "Onboarding Manager", note: "I read every reply." },
  });
  assert.ok(html.includes("Marta Ruiz"));
  assert.ok(html.includes("Onboarding Manager"));
  assert.ok(html.includes("I read every reply."));
});

test("a signature is escaped like any other untrusted text", () => {
  const html = renderEmailShell("<p>hi</p>", {
    ...PLAIN,
    signature: { name: "<script>alert(1)</script>", roleTitle: "Manager" },
  });
  assert.ok(!html.includes("<script>"), `injected script tag:\n${html}`);
});

test("the plain voice still carries the hidden preheader", () => {
  const html = renderEmailShell("<p>hi</p>", { ...PLAIN, preheader: "A quick note" });
  assert.ok(html.includes("A quick note"));
  assert.ok(html.includes("display:none"));
});

// The whole point of the default: adding a voice must not have changed a single
// byte of what every existing send already produces.
test("omitting voice is byte-identical to the branded shell", () => {
  const opts = {
    testMode: true,
    preheader: "hello",
    cta: { label: "Open", url: "https://example.com/x" },
    locale: "fr",
  };
  assert.equal(renderEmailShell("<p>c</p>", opts), renderEmailShell("<p>c</p>", { ...opts, voice: "branded" }));
});

// Until 2026-08-19 the branded shell ignored `unsubscribeUrl` entirely, so
// every branded recruiting touch went out with no unsubscribe link while /help
// promised one at the bottom of every email. Now both shells render it when
// given, and neither invents one when not.
test("the branded voice renders the unsubscribe link when given, and nothing when not", () => {
  const base = renderEmailShell("<p>c</p>", { testMode: true });
  assert.ok(!base.includes("unsubscribe"), "no link when no url");
  const withUnsub = renderEmailShell("<p>c</p>", { testMode: true, unsubscribeUrl: "https://x/y" });
  assert.ok(withUnsub.includes('href="https://x/y"'));
  assert.ok(withUnsub.includes("Stop receiving these"));
  // Only the footer anchor differs — nothing else about the branded shell moved.
  assert.equal(withUnsub.replace(/ <a href="https:\/\/x\/y"[^>]*>Stop receiving these<\/a>/, ""), base);
});
