// Pure recruiting-outreach content builder — one function that renders ANY
// touch of the cold-outreach funnel from the catalog. Alias-free (relative
// imports only) so plain `node --test` can reach it, same constraint as
// lib/offerEmailContent.ts and lib/offerSmsContent.ts.
//
// WHY fixed templates rather than an AI draft: this pitch is the same for
// everyone, so it comes from the catalog and is translated like every other
// florist-facing string. What we lose is the researched opening ("your 4.8
// stars across 214 reviews stood out") — so the evidence line below branches on
// whether we actually HAVE that signal, rather than asserting "your excellent
// reviews" at a shop we know nothing about.
//
// WHY one builder for seven touches rather than seven builders: every touch is
// greeting + N paragraphs + an optional CTA. The ONLY thing that varies is
// which keys, and whether a paragraph has a city-free variant. Encoding that as
// data (TOUCHES below) keeps "add a touch" to one table entry, and makes the
// funnel's shape reviewable in one screen instead of spread across builders.

import { tWithOverrides, type Locale } from "./i18n/index.ts";
import { toGsm7Safe } from "./smsSegments.ts";

/** The touches of the cold-outreach funnel. See lib/i18n/messages/en.ts for
 * what each one argues, and lib/sequences/definitions.ts for when each fires. */
export type RecruitTouch =
  | "t1" | "t2" | "t3" | "r1" | "r2" | "co1" | "co2"
  // Reactivation: florists who already joined (namespace `reactivate`).
  | "ra1" | "ra2" | "rd1" | "rd2";

export const RECRUIT_TOUCHES: readonly RecruitTouch[] = ["t1", "t2", "t3", "r1", "r2", "co1", "co2"];

/** The reactivation touches, which live under `email.reactivate.*`. */
export const REACTIVATE_TOUCHES: readonly RecruitTouch[] = ["ra1", "ra2", "rd1", "rd2"];

/** A paragraph slot in a touch. `city: true` means the key has a `…NoCity`
 * sibling used when we don't know the delivery city — NOT a fallback for a
 * missing translation, which `t()` already handles per-key. */
interface Para {
  key: string;
  city?: boolean;
  /** This paragraph is the "why we're writing to YOU" line, and its wording
   * branches on whether we've actually seen a review for this shop:
   * `evidenceReviews` ("well reviewed in {city}") when we have, `evidence`
   * ("came up while we were looking") when we haven't. It always renders —
   * dropping it would leave the email with no reason for having arrived. */
  evidence?: boolean;
}

interface TouchSpec {
  /** True when the subject has a `subjectNoCity` sibling. */
  subjectCity: boolean;
  paras: Para[];
}

const TOUCHES: Record<RecruitTouch, TouchSpec> = {
  t1: {
    subjectCity: true,
    paras: [
      { key: "p1", city: true },
      { key: "p2" },
      { key: "evidence", city: true, evidence: true },
      { key: "p3" },
      { key: "p4" },
      { key: "p5" },
    ],
  },
  t2: {
    subjectCity: true,
    paras: [{ key: "p1", city: true }, { key: "p2" }, { key: "p3" }, { key: "p4" }],
  },
  t3: {
    subjectCity: false,
    paras: [{ key: "p1" }, { key: "p2" }, { key: "p3" }, { key: "p4" }, { key: "p5" }],
  },
  r1: {
    subjectCity: false,
    paras: [{ key: "p1" }, { key: "p2" }, { key: "p3" }],
  },
  r2: {
    subjectCity: false,
    paras: [{ key: "p1" }, { key: "p2" }],
  },
  co1: {
    subjectCity: true,
    paras: [{ key: "p1", city: true }, { key: "p2" }, { key: "p3" }, { key: "p4" }],
  },
  co2: {
    subjectCity: true,
    paras: [{ key: "p1" }, { key: "p2" }],
  },
  // ---- reactivation ----
  ra1: { subjectCity: false, paras: [{ key: "p1" }, { key: "p2" }, { key: "p3" }, { key: "p4" }] },
  ra2: { subjectCity: false, paras: [{ key: "p1" }, { key: "p2" }] },
  rd1: { subjectCity: true, paras: [{ key: "p1", city: true }, { key: "p2" }, { key: "p3" }] },
  rd2: { subjectCity: false, paras: [{ key: "p1" }, { key: "p2" }] },
};

export interface RecruitingVars {
  /** Delivery city we're recruiting for. Null falls back to alternate,
   * city-free sentences rather than interpolating a placeholder noun. */
  city: string | null;
  /** True only when we have a real rating/review signal for this shop. Drives
   * the "your excellent reviews are why we're writing" claim, which is a lie
   * if we've never seen a review. */
  hasReviews: boolean;
  /** Signup link for this shop, when one has been minted. Null drops the CTA
   * line entirely — never renders a dead button. */
  joinUrl: string | null;
  /** Public Q&A (app/help). Optional for the same reason joinUrl is: no link,
   * no line. This is a cold email to a shop that has never heard of us, so
   * "here are the answers, read them before replying" earns its place. */
  helpUrl?: string | null;
}

export interface RecruitingEmail {
  subject: string;
  /** Plain-text body, `Subject:`-free. */
  body: string;
  /** The CTA label + url, when a join link exists. The caller decides how to
   * render it: a branded button, or a plain inline link in the plain voice. */
  cta: { label: string; url: string } | null;
}

/** Subject + plain-text body + CTA for one touch of the recruiting funnel.
 *
 * The persona signature is NOT appended here. It's the caller's job
 * (lib/sequences/tick.ts), because only the caller knows which persona
 * resolved and whether this touch is persona-signed at all — t1 comes from the
 * company. Keeping it out also keeps this function pure and the preview honest. */
export function buildRecruitingTouch(
  touch: RecruitTouch,
  locale: Locale,
  overrides: Record<string, string>,
  vars: RecruitingVars,
  /** Copy namespace. Defaults to "recruit"; reactivation touches pass
   * "reactivate". Matches SequenceStep.ns in lib/sequences/definitions.ts, so
   * a step, its words and its message-voice kind cannot drift apart. */
  ns: string = "recruit",
  /** The key segment to read the WORDS from, when it differs from the touch
   * whose SHAPE is being rendered. Only a duplicate passes this: it has the
   * paragraphs of `touch` but its own copy under its own key, so editing the
   * original cannot rewrite it (lib/flows/customSteps.ts). */
  stepKey: string = touch
): RecruitingEmail {
  const spec = TOUCHES[touch];
  const base = `email.${ns}.${stepKey}`;
  const { city, hasReviews, joinUrl } = vars;
  const cityVars = city ? { city } : undefined;

  const tt = (leaf: string, useCity: boolean) =>
    tWithOverrides(overrides, locale, `${base}.${leaf}`, useCity ? cityVars : undefined);

  // A key with a NoCity sibling picks the sibling when we have no city.
  const pick = (leaf: string, hasCityVariant: boolean | undefined) =>
    hasCityVariant && !city ? tt(`${leaf}NoCity`, false) : tt(leaf, Boolean(hasCityVariant));

  const subject = pick("subject", spec.subjectCity);

  const lines: string[] = [tt("greeting", false)];
  for (const para of spec.paras) {
    // The evidence line is the one paragraph that can be a lie, so it swaps
    // wording rather than asserting reviews we've never seen.
    const leaf = para.evidence ? (hasReviews ? "evidenceReviews" : "evidence") : para.key;
    lines.push("", pick(leaf, para.city));
  }

  return {
    subject,
    body: lines.join("\n"),
    cta: joinUrl ? { label: tt("cta", false), url: joinUrl } : null,
  };
}

/** Back-compat wrapper for the day-0 email in the shape the outreach panel
 * already parses (lib/outreach.ts::parseDraft splits on a `Subject:` prefix)
 * and a reviewer can edit before sending. The CTA is folded into the body as a
 * trailing line, which is what a plain-text draft can carry. */
export function buildRecruitingEmail(
  locale: Locale,
  overrides: Record<string, string>,
  vars: RecruitingVars
): { subject: string; body: string } {
  const built = buildRecruitingTouch("t1", locale, overrides, vars);
  const lines = [built.body];
  if (built.cta) lines.push("", `${built.cta.label}: ${built.cta.url}`);
  // The public Q&A (app/help). Only on this day-0 email, not on every touch of
  // the funnel: it answers what a shop that has never heard of us wants to know
  // before replying, and repeating it on each nudge would just be noise.
  if (vars.helpUrl) lines.push("", `${tWithOverrides(overrides, locale, "email.offer.helpLead")} ${vars.helpUrl}`);
  return { subject: built.subject, body: lines.join("\n") };
}

export interface RecruitingSmsVars {
  city: string | null;
  joinUrl: string;
  unsubscribeUrl: string;
  /** Persona name, for the r1 touch. Folded to GSM-7 — an accented persona
   * ("Amélie") would otherwise flip the whole message to UCS-2's 67-char
   * segments and double the bill on every send. */
  personaName?: string | null;
}

/** The recruiting SMS for a touch. Only t1 and r1 carry a text — the funnel
 * caps SMS at one message for an engaged prospect.
 *
 * The opt-out is NOT optional and matters more here than on the offer SMS —
 * this goes to a shop that has never worked with us and never asked to hear
 * from us, so the link is the only way they can make it stop. Every string is
 * written GSM-7-safe (no accents, ASCII hyphens) in every locale. */
export function buildRecruitingSmsContent(
  locale: Locale,
  overrides: Record<string, string>,
  vars: RecruitingSmsVars,
  touch: "t1" | "r1" = "t1"
): string {
  const line =
    touch === "r1"
      ? tWithOverrides(overrides, locale, "sms.recruit.r1.body", {
          name: toGsm7Safe(vars.personaName ?? ""),
          url: vars.joinUrl,
        })
      : tWithOverrides(overrides, locale, vars.city ? "sms.recruit.t1.body" : "sms.recruit.t1.bodyNoCity", {
          // City comes from the database and can carry accents (Malaga, Cordoba).
          ...(vars.city ? { city: toGsm7Safe(vars.city) } : {}),
          url: vars.joinUrl,
        });
  const optOut = tWithOverrides(overrides, locale, "sms.recruit.optOut", { url: vars.unsubscribeUrl });
  return `${line} ${optOut}`;
}
