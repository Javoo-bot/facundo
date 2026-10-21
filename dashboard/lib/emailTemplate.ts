// Communications hub, Workstream C: one shared branded HTML shell for every
// outbound email. Email clients are hostile to modern CSS, so this is
// deliberately primitive — table layout only, every style inlined per
// element, no CSS variables / color-mix / flex / grid, explicit width/height
// on the one image, and the only <style> block lives in <head> scoped to a
// single Gmail-safe media query (one of the few clients that honors <head>
// styles at all).
//
// Brand tokens are hardcoded here rather than pulled from design-system.css
// (which uses CSS variables + color-mix — neither survives an email client);
// matched by eye to the app's accent (#1F7A55) and ink scale.
//
// Pure string-templating, no I/O — safe to unit-test directly (see
// emailTemplate.test.mjs).

import { tWithOverrides, DEFAULT_LOCALE, type Locale } from "./i18n/index.ts";
import { FLORIST_BASE } from "./emailLinks.ts";
import { sanitizeRichText } from "./messages/richText.ts";

const BRAND_GREEN = "#1F7A55";
const HEADER_BG = "#F6F8F5";
const HEADLINE = "#16211B";
const BODY_TEXT = "#52625A";
const FOOTER_TEXT = "#7C8A81";
const RULE = "#E6EAE7";
const PAGE_BG = "#EDEFEC";
const TEST_BANNER_BG = "#F5ECDC";
const TEST_BANNER_TEXT = "#B4771A";
const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// The plain voice's palette. Near-black on white with a default-blue link —
// i.e. what a mail client renders when nobody styled anything. Using the brand
// green here would be the one detail that gives the whole thing away.
const PLAIN_TEXT = "#222222";
const PLAIN_LINK = "#1155CC";
const PLAIN_FOOTER = "#888888";

// Absolute origin for the header logo image — email clients have no "current
// page" to resolve a relative `/brand/...` path against. The logo lives under
// /brand/ (excluded from the host middleware), so it resolves on either
// production host; FLORIST_BASE is the shared default. See lib/emailLinks.ts.
const LOGO_URL = `${FLORIST_BASE}/brand/facundo-logo-email.png`;

// Editor-authored copy may carry a tiny formatting subset (bold, italic,
// underline, links). `sanitizeRichText` is strictly stronger than escapeHtml
// for everything else: anything outside the allowlist still comes out as
// escaped text, so plain copy renders exactly as it always has. Used for text
// the recipient READS; attributes and URLs keep the plain escape, since markup
// inside an attribute is never wanted and never safe.
// See lib/messages/richText.ts for the allowlist and why it is applied here as
// well as on save.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Escapes plain text and turns it into styled <p> blocks (blank-line
// separated paragraphs; single newlines become <br>). Use this for any
// caller-supplied or AI-drafted plain-text body headed into the shell — never
// interpolate raw text into contentHtml unescaped.
export function renderParagraphs(text: string, opts: { color?: string; size?: number } = {}): string {
  const color = opts.color ?? BODY_TEXT;
  const size = opts.size ?? 15;
  const paragraphs = text.split(/\n{2,}/).map((p) => sanitizeRichText(p).replace(/\n/g, "<br />"));
  return paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 14px 0;font-family:${FONT_STACK};font-size:${size}px;line-height:1.5;color:${color}">${p}</p>`
    )
    .join("");
}

export interface EmailCta {
  label: string;
  url: string;
}

/** How an email is dressed.
 *
 * `branded` is the shell below: logo, page background, white card, green CTA
 * button. It says "a company sent this", which is right for the first contact
 * and for every transactional message.
 *
 * `plain` looks like a person typed it in their mail client: no logo, no card,
 * no button, a plain-text signature. Used for the funnel's follow-ups, which
 * are signed by a named persona — a branded template over a personal signature
 * is a contradiction the recipient reads instantly.
 *
 * What `plain` does NOT drop: the test-mode banner (a safety device) and a
 * one-line legal/unsubscribe footer (commercial mail into DE and FR needs an
 * identifiable sender and a way out; real people's work mail has a footer too). */
export type EmailVoice = "branded" | "plain";

/** The persona sign-off rendered above the footer. Plain text lines — the same
 * three lines feed both voices and the plain-text fallback lib/email.ts
 * requires alongside every HTML send. */
export interface EmailSignature {
  name: string;
  roleTitle: string;
  /** One optional free line under the name. */
  note?: string | null;
}

export interface EmailShellOptions {
  /** Renders the "TEST MODE" banner — required whenever the send is
   *  test-mode-gated, so a redirected test send is never mistaken for real. */
  testMode?: boolean;
  /** Hidden preheader text (inbox preview snippet). */
  preheader?: string;
  /** One bulletproof table-based CTA button, rendered below the content. */
  cta?: EmailCta;
  /** Recipient's locale for the shell's own chrome (test banner, footer,
   *  `<html lang>`) — content passed in `contentHtml` is localized separately
   *  by the caller. Defaults to "en" so existing callers are unaffected. */
  locale?: Locale;
  /** Runtime DB-override layer (dashboard/app/(staff)/email-templates) for the
   *  shell's own `email.shell.*` strings (test banner, footer) — same flat
   *  `{key: value}` map callers already load via lib/messageOverrides.ts for
   *  their own content. Omitted (default `{}`) is byte-identical to the old
   *  plain-t() shell chrome. */
  overrides?: Record<string, string>;
  /** Defaults to "branded" — every existing caller is byte-identical. */
  voice?: EmailVoice;
  /** The persona sign-off. Rendered in both voices when present. */
  signature?: EmailSignature;
  /** Unsubscribe URL for the plain voice's legal footer line. Omitted in the
   *  branded voice, whose footer already carries the shell's own copy. */
  unsubscribeUrl?: string | null;
}

function renderCta(cta: EmailCta): string {
  const url = escapeHtml(cta.url);
  const label = sanitizeRichText(cta.label);
  return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px auto 0 auto">
        <tr>
          <td align="center" bgcolor="${BRAND_GREEN}" style="border-radius:8px">
            <a href="${url}" target="_blank" style="display:inline-block;padding:12px 26px;font-family:${FONT_STACK};font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;background-color:${BRAND_GREEN}">${label}</a>
          </td>
        </tr>
      </table>`;
}

/** The persona sign-off, as HTML. Same three lines in both voices — only the
 * surrounding chrome differs — so a florist who gets a branded email and then a
 * plain one is demonstrably hearing from the same person. */
export function renderSignatureBlock(sig: EmailSignature, voice: EmailVoice = "branded"): string {
  const color = voice === "plain" ? PLAIN_TEXT : BODY_TEXT;
  const lines = [
    `<span style="font-weight:600;color:${voice === "plain" ? PLAIN_TEXT : HEADLINE}">${escapeHtml(sig.name)}</span>`,
    escapeHtml(sig.roleTitle),
    "Facundo",
  ];
  const note = sig.note
    ? `<p style="margin:10px 0 0 0;font-family:${FONT_STACK};font-size:${voice === "plain" ? 15 : 14}px;line-height:1.5;color:${color}">${sanitizeRichText(sig.note)}</p>`
    : "";
  return `<p style="margin:20px 0 0 0;font-family:${FONT_STACK};font-size:${voice === "plain" ? 15 : 14}px;line-height:1.5;color:${color}">${lines.join("<br />")}</p>${note}`;
}

/** The plain voice: an email that reads as though a person typed it.
 *
 * Deliberately NOT a stripped copy of the branded shell — it is a different
 * document. No outer table, no background colour, no card, no logo, no button.
 * What survives is what must: the preheader (inbox preview is not decoration),
 * the test banner, and one muted legal line. */
function renderPlainShell(contentHtml: string, opts: EmailShellOptions): string {
  const { testMode, preheader, cta, locale = DEFAULT_LOCALE, overrides = {}, signature, unsubscribeUrl } = opts;

  const preheaderHtml = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px">${escapeHtml(preheader)}</div>`
    : "";

  // Still shown, and shown FIRST. app_settings.test_mode defaults to true, and
  // a redirected test send that looks exactly like a real one is precisely the
  // mistake this banner exists to prevent. Aesthetics do not outrank it.
  const banner = testMode
    ? `<p style="margin:0 0 16px 0;font-family:${FONT_STACK};font-size:13px;font-weight:700;color:${TEST_BANNER_TEXT}">${escapeHtml(tWithOverrides(overrides, locale, "email.shell.testBanner"))}</p>`
    : "";

  // A person links; a company puts a button on it. renderLinkLine already
  // renders exactly this shape, so the CTA degrades rather than disappearing.
  const ctaHtml = cta
    ? `<p style="margin:16px 0 0 0;font-family:${FONT_STACK};font-size:15px;line-height:1.5;color:${PLAIN_TEXT}"><a href="${escapeHtml(cta.url)}" target="_blank" style="color:${PLAIN_LINK};text-decoration:underline">${sanitizeRichText(cta.label)}</a></p>`
    : "";

  const signatureHtml = signature ? renderSignatureBlock(signature, "plain") : "";

  // The one thing a "hand-written" email still owes the recipient: who sent it
  // and how to stop it. Commercial mail into DE (Impressum) and FR (mentions
  // légales) needs an identifiable sender, and List-Unsubscribe alone is not
  // that. One muted line costs nothing in authenticity.
  const footerText = escapeHtml(tWithOverrides(overrides, locale, "email.shell.plainFooter"));
  const unsubHtml = unsubscribeUrl
    ? ` <a href="${escapeHtml(unsubscribeUrl)}" target="_blank" style="color:${PLAIN_FOOTER};text-decoration:underline">${escapeHtml(tWithOverrides(overrides, locale, "email.shell.plainUnsubscribe"))}</a>`
    : "";

  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light" />
<title></title>
</head>
<body style="margin:0;padding:0">
${preheaderHtml}
<div style="max-width:600px;margin:0;padding:16px;font-family:${FONT_STACK};font-size:15px;line-height:1.5;color:${PLAIN_TEXT}">
${banner}
${contentHtml}
${ctaHtml}
${signatureHtml}
<p style="margin:24px 0 0 0;font-family:${FONT_STACK};font-size:11px;line-height:1.5;color:${PLAIN_FOOTER}">${footerText}${unsubHtml}</p>
</div>
</body>
</html>`;
}

/** Renders the HTML email shell around `contentHtml` (already-safe HTML —
 * escape/build it with `renderParagraphs`/`escapeHtml` before passing it in).
 * Always author a plain-text `body` fallback alongside this — lib/email.ts
 * requires it and never sends HTML-only.
 *
 * `opts.voice` selects the branded shell (default, unchanged) or the plain
 * hand-written look. */
export function renderEmailShell(contentHtml: string, opts: EmailShellOptions = {}): string {
  if (opts.voice === "plain") return renderPlainShell(contentHtml, opts);

  const { testMode, preheader, cta, locale = DEFAULT_LOCALE, overrides = {}, signature, unsubscribeUrl } = opts;
  // The branded shell used to drop `unsubscribeUrl` on the floor — only the
  // plain shell rendered it — so every branded recruiting touch (the day-0 the
  // tick now sends to auto-enrolled shops included) went out with no way to
  // stop it, while /help promised "every email has an unsubscribe link at the
  // bottom". Same anchor as the plain shell, in the branded footer colour.
  const brandedUnsubHtml = unsubscribeUrl
    ? ` <a href="${escapeHtml(unsubscribeUrl)}" target="_blank" style="color:${FOOTER_TEXT};text-decoration:underline">${escapeHtml(tWithOverrides(overrides, locale, "email.shell.plainUnsubscribe"))}</a>`
    : "";

  const preheaderHtml = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px">${escapeHtml(preheader)}</div>`
    : "";

  const bannerRow = testMode
    ? `
      <tr>
        <td bgcolor="${TEST_BANNER_BG}" style="padding:10px 24px;text-align:center;font-family:${FONT_STACK};font-size:13px;font-weight:700;color:${TEST_BANNER_TEXT}">${escapeHtml(tWithOverrides(overrides, locale, "email.shell.testBanner"))}</td>
      </tr>`
    : "";

  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light" />
<!-- Empty: mail clients ignore <title>; left blank rather than duplicating
     the header logo image's alt text ("Facundo") for no reader benefit. -->
<title></title>
<style>
  @media only screen and (max-width: 600px) {
    .fc-container { width: 100% !important; }
    .fc-card { padding: 24px 20px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${PAGE_BG}">
${preheaderHtml}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${PAGE_BG}">${bannerRow}
  <tr>
    <td bgcolor="${HEADER_BG}" style="padding:0;border-top:3px solid ${BRAND_GREEN}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td align="center" style="padding:20px 24px">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle"><img src="${LOGO_URL}" width="121" height="32" alt="Facundo" style="display:block;border:0" /></td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:32px 16px">
      <table role="presentation" class="fc-container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px">
        <tr>
          <td class="fc-card" bgcolor="#FFFFFF" style="padding:32px;border-radius:12px">
            ${contentHtml}
${cta ? renderCta(cta) : ""}
${signature ? renderSignatureBlock(signature, "branded") : ""}
          </td>
        </tr>
      </table>
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:0 24px 32px 24px">
      <p style="margin:0;font-family:${FONT_STACK};font-size:12px;line-height:1.5;color:${FOOTER_TEXT}">${escapeHtml(tWithOverrides(overrides, locale, "email.shell.footer"))}${brandedUnsubHtml}</p>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** A headline `<h1>`-ish line for the top of a content slot. Not exported as
 * part of `renderEmailShell` itself (callers compose their own content), but
 * shared so every send gets the same headline styling. */
export function renderHeadline(text: string): string {
  return `<p style="margin:0 0 12px 0;font-family:${FONT_STACK};font-size:20px;font-weight:700;color:${HEADLINE}">${sanitizeRichText(text)}</p>`;
}

export interface FactRow {
  label: string;
  value: string;
}

/** Facts-first key/value block (label left, bold value right) as a plain
 * HTML table — for the offer email (payout · area · deliver-by) and anywhere
 * else a "here's what you need to decide" block is useful. Skips rendering
 * entirely when `rows` is empty (nothing to show). */
export function renderFactsBlock(rows: FactRow[]): string {
  if (rows.length === 0) return "";
  const trs = rows
    .map(
      (r, i) => `
        <tr>
          <td style="padding:8px 0;${i > 0 ? `border-top:1px solid ${RULE};` : ""}font-family:${FONT_STACK};font-size:13px;color:${FOOTER_TEXT}">${escapeHtml(r.label)}</td>
          <td align="right" style="padding:8px 0;${i > 0 ? `border-top:1px solid ${RULE};` : ""}font-family:${FONT_STACK};font-size:13px;font-weight:700;color:${HEADLINE}">${escapeHtml(r.value)}</td>
        </tr>`
    )
    .join("");
  return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px 0">${trs}
      </table>`;
}

/** A single small, muted line pairing lead-in text with one inline link — for
 * footer-ish asides (unsubscribe, support contact, "how it works") that don't
 * fit renderParagraphs' plain-text escaping. Both `label` and `url` are
 * escaped; `beforeText` is the lead-in phrase on the same line. */
export function renderLinkLine(beforeText: string, label: string, url: string): string {
  return `<p style="margin:0 0 4px 0;font-family:${FONT_STACK};font-size:12px;line-height:1.5;color:${FOOTER_TEXT}">${sanitizeRichText(beforeText)} <a href="${escapeHtml(url)}" target="_blank" style="color:${BRAND_GREEN};text-decoration:underline">${sanitizeRichText(label)}</a></p>`;
}
