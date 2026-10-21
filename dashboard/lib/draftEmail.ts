export interface DraftFacts {
  name: string;
  rating: number | null;
  review_count: number | null;
  owner_name: string | null;
  shop_highlight: string | null;
}

/** Shop's own site language wins; else the region's Maps language; else English.
 * Mirrors ingest/main.py::resolve_target_language. */
export function resolveTargetLanguage(
  contentLanguage: string | null,
  regionLanguage: string | null
): string {
  for (const candidate of [contentLanguage, regionLanguage]) {
    if (candidate && candidate.trim()) return candidate.trim();
  }
  return "en";
}

/** Assemble the outreach-draft prompt.
 *
 * The email's CONTENT is no longer described to the model in prose — it is
 * handed over verbatim as `canonicalEmail`, rendered from the catalog by
 * lib/recruitingContent.ts::buildRecruitingEmail. That makes the catalog the
 * single source of truth for what we promise (the 70/30 split, no fee, no
 * commitment, the four steps): editing the copy in the email-templates editor
 * changes what the model is told to say, with no deploy and no prompt edit.
 *
 * What the model still does — and why this isn't just a fixed template — is
 * the part that earns a reply from a shop that has never heard of us:
 *   - writes the whole thing in the florist's OWN language, whatever that is
 *     (we support six locales; there are far more languages than that);
 *   - greets the owner by name when we know it;
 *   - opens on something we actually researched about THIS shop.
 *
 * It is explicitly forbidden from inventing facts or dropping the terms. */
export function buildDraftPrompt(
  facts: DraftFacts,
  city: string,
  targetLanguage: string,
  canonicalEmail: { subject: string; body: string }
): string {
  const greetingInstruction = facts.owner_name
    ? `Address the owner by name: greet ${facts.owner_name} personally, translated naturally into the target language.`
    : "We do NOT have a confirmed owner name. Use a warm, natural greeting addressing the shop or team in the target language (e.g. the equivalent of 'Hello' or 'Hi there'). Never invent a name and never leave a placeholder.";

  let openingInstruction: string;
  if (facts.shop_highlight) {
    openingInstruction = `Replace the generic opening with this specific, researched detail about the shop, phrased naturally in the target language: "${facts.shop_highlight}". Make it clear we actually looked at their business.`;
  } else if (facts.rating != null && facts.review_count != null) {
    openingInstruction = `Open by warmly noting their strong reputation: a ${facts.rating}-star rating across ${facts.review_count} reviews stood out while researching ${city}.`;
  } else {
    openingInstruction = `Open by warmly noting they stood out while we researched high-quality florists in ${city}. We have NO rating or review data for this shop, so do not claim to have read their reviews.`;
  }

  return `You are adapting a fixed outreach email from Facundo, a global flower-delivery network that partners with local florists, for one specific florist we found while researching ${city}.

Below is the approved email. Its OFFER and TERMS are fixed and must all survive: the 70% paid on accept, the remaining 30% released on the photo before delivery, no fee, no commitment, no minimum, orders by email/SMS/WhatsApp, and the closing invitation to join. Do not add promises that are not in it. Do not remove any of them.

--- APPROVED EMAIL ---
Subject: ${canonicalEmail.subject}

${canonicalEmail.body}
--- END APPROVED EMAIL ---

Your job is to make it read as though a real person who looked at THIS shop wrote it, NOT a mail merge:

Language: write the entire email in this language (BCP-47 code): ${targetLanguage}. If that code is NOT English, then after the email add a line containing only "---" and below it a faithful English version of the same email (its subject included). If it IS English, output only the one email: no translation, no divider.

Format: begin the output with a subject line in exactly this form: the literal ASCII label "Subject:" (always this exact English word, never translated or localized), a space, then the subject text itself written in the target language, then a blank line, then the greeting and body. When you add the English version, it too begins with its own "Subject:" line. Put nothing before the first "Subject:" line.

Greeting: ${greetingInstruction}

Opening: ${openingInstruction}

Keep the four numbered steps as numbered steps, and keep any join link exactly as it appears above: copy the URL character for character, and never invent one. Stay close to the approved email's length; you are personalising it, not rewriting it. Never use an em dash (\u2014) anywhere in the output, including the divider: use a comma, a colon or a full stop instead. This is a house style rule AND a technical one, so it is not optional. No literal placeholders (never output text in curly braces), no invented facts about the shop.

Return only the email(s), nothing else.

Reference facts (do not restate mechanically, weave in naturally):
- Shop name: ${facts.name}
- City: ${city}
`;
}
