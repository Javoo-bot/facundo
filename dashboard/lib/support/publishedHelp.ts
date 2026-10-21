// Deterministic published-content grounding for the support agent.
//
// Reuses lib/help/content.ts — the same staff-reviewed Q&A a florist reads on
// /help and /florist/help — rather than forking a second copy of "how the app
// works" or "how the split works" into the agent's prompt. Adding a topic here
// is a one-line change to SUPPORT_HELP_ARTICLE_IDS; the wording itself always
// comes from the help centre, so a correction made in /faq (the
// message-overrides layer) reaches the chat with no deploy, exactly as it
// reaches /help.
//
// Deliberately narrower than the whole help centre. v1 scope
// (docs/superpowers/specs/2026-08-15-florist-operations-assistant-scope-design.md)
// covers app mechanics (App Guide / Troubleshooter) and the general, published
// policy every florist shares (Policy Assistant: getting paid, the card, the
// substitution rule). Explicitly EXCLUDED: wrong-address, cant-fulfil — each
// is a live/substantive order problem dressed as a how-to, and grounding the
// model on them risks a policy-shaped answer reading as though it settled a
// real, in-flight case. Those stay delivery_problem, answered from nothing
// but "Report a problem", exactly as today.
//
// Alias-free (relative imports only), same constraint as lib/supportFacts.ts,
// so plain `node --test` reaches it without the Next.js path aliases.

import { HELP_ARTICLES, helpKey, type HelpArticle } from "../help/content.ts";
import { tWithOverrides, type Locale } from "../i18n/index.ts";

/** The v1 article set. Order doesn't matter for the prompt; grouped here by
 * bucket for readability. */
export const SUPPORT_HELP_ARTICLE_IDS: readonly string[] = [
  // App Guide / Troubleshooter
  "how-offers-arrive",
  "accept-an-order",
  "what-do-i-make",
  "delivery-photo",
  "install-app",
  "working-language",
  "teammates",
  // Policy Assistant
  "getting-paid",
  "the-card",
  "photo-not-approved",
  "missing-flower",
];

/** The articles resolved for real, so a renamed or removed id fails the build
 * loudly (via publishedHelp.test.mjs) instead of silently dropping a topic. */
export const SUPPORT_HELP_ARTICLES: HelpArticle[] = HELP_ARTICLES.filter((a) =>
  SUPPORT_HELP_ARTICLE_IDS.includes(a.id)
);

/**
 * The published-policy/how-to lines for one support turn: one question and its
 * staff-approved answer per line, straight from the help centre's own copy
 * (through the same override layer /faq writes to), in the florist's locale.
 *
 * Deliberately near-verbatim rather than a paraphrase the model regenerates
 * each call — the risk this avoids is wording drifting from the staff-approved
 * article over time, the same reasoning lib/supportFacts.ts applies to order
 * figures.
 *
 * Pure — `overrides` is the caller's already-loaded lib/messageOverrides.ts
 * result (lib/agentTurn.ts already loads it for the send-side copy), so this
 * function does no I/O of its own.
 */
export function buildPublishedHelpLines(overrides: Record<string, string>, locale: Locale): string[] {
  return SUPPORT_HELP_ARTICLES.map((a) => {
    const q = tWithOverrides(overrides, locale, helpKey(a.id, "q"));
    const body = tWithOverrides(overrides, locale, helpKey(a.id, "body"));
    return `Q: ${q} A: ${body}`;
  });
}
