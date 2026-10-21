// How a recruiting/reactivation touch becomes an actual email: the shell, the
// headline-or-not decision, the signature, and the plain-text half.
//
// Extracted from lib/sequences/tick.ts::deliver so the funnel editor's "send
// me a test" button goes through the SAME composition the tick does. The
// no-drift property the offer email has had since lib/offerEmailContent.ts —
// the preview cannot show something a send would not produce — is the whole
// point of this file existing rather than the route composing its own shell.
//
// Not pure (renderEmailShell reads the catalog for its footer), but I/O-free:
// everything it needs is an argument.

import { renderEmailShell, renderParagraphs, renderHeadline } from "./emailTemplate.ts";
import { renderSignature, type Persona } from "./personas.ts";
import { tWithOverrides, type Locale } from "./i18n/index.ts";
import type { EmailVoice } from "./messageVoice.ts";
import type { RecruitingEmail } from "./recruitingContent.ts";

export interface ComposedEmail {
  subject: string;
  html: string;
  bodyText: string;
}

export interface ComposeRecruitingOpts {
  locale: Locale;
  overrides: Record<string, string>;
  voice: EmailVoice;
  /** The persona signing it, or null for a company-voice touch. */
  persona: Persona | null;
  /** Null drops the line rather than rendering a dead link. */
  unsubscribeUrl: string | null;
  testMode: boolean;
}

/** Subject + HTML + plain text for one recruiting touch, ready for
 * lib/email.ts. `built` comes from buildRecruitingTouch. */
export function composeRecruitingEmail(built: RecruitingEmail, opts: ComposeRecruitingOpts): ComposedEmail {
  const { locale, overrides, voice, persona, unsubscribeUrl, testMode } = opts;

  const signature = persona
    ? { name: persona.name, roleTitle: persona.role_title, note: persona.signature_note }
    : undefined;

  const [headline, ...rest] = built.body.split("\n\n");
  const contentHtml =
    voice === "plain"
      // A person doesn't open with a styled headline — the greeting is just
      // the first line of the message.
      ? renderParagraphs(built.body)
      : renderHeadline(headline) + renderParagraphs(rest.join("\n\n"));

  const html = renderEmailShell(contentHtml, {
    testMode,
    locale,
    overrides,
    voice,
    signature,
    preheader: built.subject,
    cta: built.cta ? { label: built.cta.label, url: built.cta.url } : undefined,
    unsubscribeUrl,
  });

  // lib/email.ts never sends HTML-only; the plain-text fallback carries the
  // signature too so both halves say the same thing, and the unsubscribe link
  // as well — a text-only client must not be the one place the promise on
  // /help does not hold.
  const bodyText = [
    built.body,
    built.cta ? `${built.cta.label}: ${built.cta.url}` : null,
    persona ? renderSignature(persona) : null,
    unsubscribeUrl
      ? `${tWithOverrides(overrides, locale, "email.shell.plainUnsubscribe")}: ${unsubscribeUrl}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  return { subject: built.subject, html, bodyText };
}
