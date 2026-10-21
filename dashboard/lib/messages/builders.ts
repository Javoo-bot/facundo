// Pure content builders for the messages that used to assemble their HTML
// inside a send function.
//
// Before this, only the offer email (lib/offerEmailContent.ts) and the offer
// SMS could be rendered without touching the database, so nothing else could be
// previewed. Each builder here is the exact assembly its send site used to do
// inline, lifted out unchanged: same helpers, same order, same strings. The
// send site now calls the builder, so send and preview share one code path and
// cannot drift — the property offerEmailContent.ts's header comment describes.
//
// Relative imports only, like its siblings, so plain `node --test` can reach
// this file without tsconfig path aliases.
import {
  escapeHtml,
  renderEmailShell,
  renderFactsBlock,
  renderHeadline,
  renderParagraphs,
} from "../emailTemplate.ts";
import { tWithOverrides, type Locale } from "../i18n/index.ts";
import { issueLabel } from "../i18n/issueLabels.ts";

export interface BuiltMessage {
  subject: string;
  html: string;
  bodyText: string;
}

/** Issue thread: Facundo replied / resolved, to the florist. `kind` picks
 * the subject key; the body is CX's free-typed text and is never translated. */
export function buildIssueFloristEmail(
  locale: Locale,
  overrides: Record<string, string>,
  vars: { kind: "replied" | "resolved"; orderLabel: string; message: string; orderUrl: string; testMode: boolean }
): BuiltMessage {
  const tt = (k: string, v?: Record<string, string | number>) => tWithOverrides(overrides, locale, k, v);
  const subject = tt(vars.kind === "replied" ? "email.issue.repliedSubject" : "email.issue.resolvedSubject", {
    orderLabel: vars.orderLabel,
  });
  const bodyText = `${vars.message}\n\nOpen the order to reply:\n${vars.orderUrl}`;
  const html = renderEmailShell(renderHeadline(subject) + renderParagraphs(vars.message), {
    testMode: vars.testMode,
    locale,
    overrides,
    cta: { label: tt("email.issue.cta"), url: vars.orderUrl },
  });
  return { subject, html, bodyText };
}

/** Issue thread: a florist reported a problem, to our own CX inbox. Internal
 * and English-only, so the CTA label is a literal here exactly as it was at the
 * send site — it is not a catalog key and never has been. */
export function buildIssueCxEmail(
  overrides: Record<string, string>,
  vars: { orderLabel: string; issueType: string; author: string; message: string; orderUrl: string; testMode: boolean }
): BuiltMessage {
  const subject = `Florist issue · ${vars.orderLabel} · ${issueLabel("en", vars.issueType, overrides)}`;
  const lead = `${vars.author} on order ${vars.orderLabel}:\n\n"${vars.message}"`;
  const bodyText = `${lead}\n\nOpen the order to reply or resolve:\n${vars.orderUrl}`;
  const html = renderEmailShell(renderHeadline(subject) + renderParagraphs(lead), {
    testMode: vars.testMode,
    locale: "en",
    overrides,
    cta: { label: "Open order", url: vars.orderUrl },
  });
  return { subject, html, bodyText };
}

/** Staff-sent sign-in link, optionally deep-linked to one order. */
export function buildMagicLinkEmail(
  locale: Locale,
  overrides: Record<string, string>,
  vars: { orderLabel: string | null; url: string; testMode: boolean }
): BuiltMessage {
  const tt = (k: string, v?: Record<string, string | number>) => tWithOverrides(overrides, locale, k, v);
  const forOrder = vars.orderLabel != null;
  const subject = forOrder
    ? tt("email.magicLink.subjectOrder", { orderLabel: vars.orderLabel! })
    : tt("email.magicLink.subject");
  const bodyLine = forOrder ? tt("email.magicLink.bodyOrder") : tt("email.magicLink.body");
  const ctaLabel = forOrder ? tt("email.magicLink.ctaOrder") : tt("email.magicLink.cta");

  const html = renderEmailShell(
    `<h1 style="margin:0 0 12px;font-size:20px">${escapeHtml(tt("email.magicLink.headline"))}</h1>
     <p style="margin:0 0 12px">${escapeHtml(bodyLine)}</p>
     <p style="margin:0;color:#6b7280;font-size:13px">${escapeHtml(tt("email.magicLink.ignore"))}</p>`,
    { testMode: vars.testMode, locale, preheader: tt("email.magicLink.preheader"), cta: { label: ctaLabel, url: vars.url } }
  );
  const bodyText = [tt("email.magicLink.headline"), "", bodyLine, "", vars.url, "", tt("email.magicLink.ignore")].join("\n");
  return { subject, html, bodyText };
}

/** Client-facing order notice (assigned / on the way / delivered). Customers
 * are English-only by decision, so `locale` is always "en" at the send site —
 * it stays a parameter so a preview can show what a translated one would look
 * like the day that changes. `photoHtml` is the delivered-photo block, resolved
 * by the caller because it needs a signed URL. */
export function buildClientNoticeEmail(
  locale: Locale,
  overrides: Record<string, string>,
  vars: { kind: "assigned" | "on_the_way" | "delivered"; photoHtml?: string | null; testMode: boolean }
): BuiltMessage {
  const tt = (k: string) => tWithOverrides(overrides, locale, k);
  const subject = tt(`email.client.${vars.kind}.subject`);
  const body = tt(`email.client.${vars.kind}.body`);
  const contentHtml = vars.photoHtml || renderHeadline(subject) + renderParagraphs(body);
  const html = renderEmailShell(contentHtml, { testMode: vars.testMode, locale, overrides });
  return { subject, html, bodyText: body };
}

/** CX queue alert, to our own inbox. Internal and English-only; the subject and
 * the line format are literals here exactly as they are at the send site. */
export function buildCxAlertEmail(
  overrides: Record<string, string>,
  vars: { lines: string[]; more: number; queueUrl: string; testMode: boolean }
): BuiltMessage {
  const count = vars.lines.length + vars.more;
  const plural = count === 1 ? "" : "s";
  const subject = `CX: ${count} order${plural} need${plural ? "" : "s"} attention`;
  const moreLine = vars.more > 0 ? `\n…and ${vars.more} more.` : "";
  const listed = `${vars.lines.join("\n")}${moreLine}`;
  const bodyText = `${listed}\n\nOpen the control panel:\n${vars.queueUrl}`;
  // Overrides are threaded through so the shared chrome (test banner, footer)
  // is editable. This alert's OWN copy — subject, the per-order line format,
  // the CTA label — is hardcoded above and has never been in the catalog, so
  // it is not editable yet. Moving it there is a follow-up; pretending
  // otherwise would give the editor fields that change nothing.
  const html = renderEmailShell(renderHeadline(subject) + renderParagraphs(listed), {
    testMode: vars.testMode,
    locale: "en",
    overrides,
    cta: { label: "Open control panel", url: vars.queueUrl },
  });
  return { subject, html, bodyText };
}

/** Settings → "Send test email". Always carries the test banner: this send
 * exists only to prove the pipe works. */
export function buildTestEmail(
  overrides: Record<string, string>,
  vars: { sentBy: string; sentAt: string; backofficeUrl: string }
): BuiltMessage {
  // Was "Facundo — test email". The em dash is gone for the same reason it
  // is gone from the catalogs: house rule, and U+2014 is outside GSM-7 so it
  // must never be copy-pasted from here into anything that can reach an SMS.
  const subject = "Facundo test email";
  const body =
    "This is a sample Facundo email, sent to confirm the branded template renders correctly and mail delivery is working. No action is needed.";
  const html = renderEmailShell(
    renderHeadline(subject) +
      renderParagraphs(body) +
      renderFactsBlock([
        { label: "Sent by", value: vars.sentBy },
        { label: "Sent at", value: vars.sentAt },
      ]),
    // Like the CX alert: this message's own copy is hardcoded and has never
    // been in the catalog, but the shared chrome is, so overrides are threaded
    // through and the banner/footer stay editable.
    { testMode: true, locale: "en", overrides, cta: { label: "Open backoffice", url: vars.backofficeUrl } }
  );
  return { subject, html, bodyText: body };
}
