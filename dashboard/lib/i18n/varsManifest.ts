// Maps each catalog key that takes `{var}` placeholders to the var names its
// send site interpolates, derived by reading the actual call sites
// (lib/reachoutSend.ts, lib/clientComms.ts, lib/issueComms.ts,
// app/api/florists/draft-email/route.ts). Keys that take no vars are simply
// omitted (empty/missing reads as "no required vars").
//
// Pure data, no I/O — used by the email-templates editor to warn (never
// block) when an edited value is missing a `{var}` its send site expects. Keep
// this in sync when a call site's `vars` object changes; nothing enforces it
// automatically (there's no reverse-lookup from t() calls to this file).
export const VARS_MANIFEST: Record<string, string[]> = {
  // The 2026-08-05 rewrite dropped {orderName}/{when} from both subjects. The
  // send site still resolves and passes both, so an editor override is free to
  // put either back — they're just no longer required by the default copy, and
  // listing them here would warn on every edit of a subject that legitimately
  // omits them.
  "email.offer.subject": ["city"],
  "email.offer.subjectNoCity": [],
  "email.offer.intro": ["city"],
  "email.offer.replyWindowNote": ["window"],
  "email.offer.replyWindow.minutes": ["count"],
  "email.offer.replyWindow.hours": ["count"],
  "email.issue.resolvedSubject": ["orderLabel"],
  "email.issue.repliedSubject": ["orderLabel"],
  // The recruiting funnel's city-bearing keys. Every touch's `subject`/`p1`
  // (and t1's evidence line) interpolates {city}; their `…NoCity` siblings take
  // no vars and are omitted. The CTA carries its url out-of-band now
  // (RecruitingEmail.cta), so no email.recruit key takes a link placeholder.
  "email.recruit.t1.subject": ["city"],
  "email.recruit.t1.p1": ["city"],
  "email.recruit.t1.evidenceReviews": ["city"],
  "email.recruit.t1.evidence": ["city"],
  "email.recruit.t2.subject": ["city"],
  "email.recruit.t2.p1": ["city"],
  "email.recruit.co1.subject": ["city"],
  "email.recruit.co1.p1": ["city"],
  "email.recruit.co2.subject": ["city"],
  // The 2026-08-05 SMS rewrite replaced the euro figure and the countdown with
  // a single {deadline} fragment, which is itself either byTime or within.
  "sms.offer.body": ["city", "url", "deadline"],
  "sms.offer.bodyNoCity": ["url", "deadline"],
  "sms.offer.repeat": ["floristName", "url", "deadline"],
  "sms.offer.byTime": ["time"],
  "sms.offer.within": ["window"],
  "sms.offer.optOut": ["url"],
  "sms.recruit.t1.body": ["city", "url"],
  "sms.recruit.t1.bodyNoCity": ["url"],
  "sms.recruit.r1.body": ["name", "url"],
  "sms.recruit.optOut": ["url"],
  "email.offer.deadlineNote": ["time"],
  // The Q&A (components/help/HelpCenter.tsx) quotes the support address from
  // settings rather than hardcoding it in six locales, so an override that
  // drops {supportEmail} would leave a florist with nowhere to write.
  "ui.help.a.contact-us.body": ["supportEmail"],
};

/** The `{var}` names a key's template expects, or `[]` if it takes none. */
export function expectedVars(key: string): string[] {
  return VARS_MANIFEST[key] ?? [];
}

/** `{var}` names present in `expectedVars(key)` but missing from `value` —
 * empty when nothing's missing (or the key takes no vars). Warn-only signal
 * for the editor; a value is still saved even if this is non-empty. */
export function missingVars(key: string, value: string): string[] {
  return expectedVars(key).filter((name) => !value.includes(`{${name}}`));
}
