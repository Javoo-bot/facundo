// Prompt templates ported verbatim from ingest/prompts.py. (The outreach draft
// prompt is NOT here — that moved to dashboard/lib/draftEmail.ts in Phase 0.)

export function ecommerceClassificationPrompt(htmlExcerpt: string): string {
  return `You are classifying whether a florist's website supports online ordering (ecommerce) — i.e. a customer can select products and pay online, as opposed to a purely informational "brochure" site with a phone number and address.

Rule-based signals (platform names, cart/checkout links, product schema) did not conclusively match on this site, so you're the fallback. Look at the HTML below and decide:

- is_ecommerce: true if there is a clear way to buy something online (a cart, checkout flow, "add to cart" style buttons, priced product listings with a purchase action). False if it's clearly just informational/contact-only. If you are genuinely unsure, make your best call but reflect the uncertainty in \`confidence\`.
- confidence: 0.0-1.0, how sure you are.
- reasoning: one or two sentences on what you saw (or didn't see).

Do not guess based on the business type alone — judge only from the HTML.

HTML (may be truncated):
---
${htmlExcerpt}
---
`;
}

export function emailExtractionPrompt(candidates: string, context: string): string {
  return `You are extracting the PRIMARY business contact email for a florist from candidate email addresses found on their website.

Candidate emails found via regex:
---
${candidates}
---

Surrounding page context (may help disambiguate which email is the real business contact vs. a CDN/tracking/placeholder address):
---
${context}
---

Rules:
- Prefer an address that looks like the shop's own contact/order email (e.g. info@, orders@, hello@, or the shop's own domain).
- Skip noreply@/no-reply@ addresses, obvious CDN/tracking/analytics addresses, and platform-hosting addresses like anything@wixsite.com or similar builder subdomains that aren't the business's real domain.
- If none of the candidates look like a genuine primary business email, return null for email — do not guess or fabricate one.
- confidence: 0.0-1.0, how sure you are this is the right primary email.
`;
}

export function phoneExtractionPrompt(candidates: string, context: string): string {
  return `You are extracting the PRIMARY business phone number for a florist from candidate phone numbers found on their website.

Candidate phone numbers found via regex:
---
${candidates}
---

Surrounding page context:
---
${context}
---

Rules:
- Prefer a number that reads as the shop's main contact/order line, not a fax number, a third-party delivery partner's number, or an unrelated number that happens to appear on the page.
- If none of the candidates look like a genuine primary business phone number, return null for phone — do not guess or fabricate one.
- confidence: 0.0-1.0, how sure you are this is the right primary phone number.
`;
}

export function ownerInfoPrompt(text: string): string {
  return `You are analyzing a small florist business using text pulled from their /about, /team, or /impressum page.

Page text (may be truncated):
---
${text}
---

Return three things:

- owner_name: the owner or founder's name, but ONLY if the text clearly identifies someone as the owner, founder, or proprietor (e.g. "Founded by Jane Smith", "Owner: John Doe") AND it is a real personal name. Do NOT return a name that is merely mentioned (a staff member, a customer testimonial, a delivery driver), and do NOT return a brand/shop name. null is the correct answer more often than not for small business sites — if the text doesn't clearly name a real owner/founder, return null. Do not guess.

- shop_highlight: ONE short, factual, genuinely distinctive detail the shop states about itself — e.g. years in business ("family-run since 1998"), a signature specialty ("known for large-scale wedding installations"), or a notable award/recognition. Draw it ONLY from the page text. Keep it to a short phrase. Return null if the text says nothing genuinely distinctive — do not invent, and do not pad with generic filler like "offers beautiful flowers".

- content_language: the BCP-47 language code of the shop's OWN website text (e.g. "es", "ca", "de", "pt-BR"). Return null if there is too little text to tell.
`;
}

export function relevanceClassificationPrompt(
  name: string,
  address: string,
  categoryName: string,
  categories: string,
  rating: number | null,
  reviewCount: number | null
): string {
  return `You are judging whether a Google Maps place that matched a florist-related search term is actually a florist / flower shop business, as opposed to some other business that happened to match the search (a supermarket with a flower section, a gift shop, a garden center, a flower wholesaler that doesn't serve retail walk-in customers, a wedding/event planner, etc.).

Google's own category for this place did not clearly match florist-style categories, so you're the fallback judge.

Name: ${name}
Address: ${address}
Google Maps category: ${categoryName}
All Google Maps categories: ${categories}
Rating: ${rating} from ${reviewCount} reviews

Decide:
- is_florist: true if this is a real florist / flower shop — a business whose primary purpose is selling or arranging cut flowers, bouquets, or floral arrangements for retail customers. False for any other business type, even one that sells some flowers as a side offering.
- A "false" here is PERMANENT — this place will be dropped and never looked at again. If you are genuinely unsure, prefer true (keep it) rather than guessing false, and reflect your uncertainty in confidence instead of the boolean.
- confidence: 0.0-1.0, how sure you are.
- reasoning: one short sentence on what you saw (or didn't see).
`;
}

export function keywordSuggestionPrompt(country: string): string {
  return `You are helping a florist-discovery tool search Google Maps for florists in a specific country using local-language search terms. English-only queries like "florist" under-collect results in non-English-speaking countries because Google Maps matches on the language people actually search in (e.g. "floristeria"/"floristería" surface different, additional results than "florist" would in Spain).

Country: ${country}

Give the common local-language search terms people would use to find a florist / flower shop on Google Maps in this country:
- Include the standard term(s) in the country's main official/majority language(s).
- Include common variant spellings (with/without accents, common misspellings that still work well as Maps search terms).
- If the country has a meaningful regional/co-official language spoken by a large population (e.g. Catalan and Basque in Spain, French/Flemish in Belgium, etc.), include the local-language term(s) for those regions too, so searches in those areas aren't missed.
- Always include the plain English "florist" as a fallback term.
- Keep the list short and high-signal — roughly 3 to 8 terms, not an exhaustive dictionary.

Also give the Google Maps \`language\` parameter code most appropriate for search results in this country's dominant language (a two-letter code, or a locale like "pt-BR" when that distinction matters).

Return:
- keywords: the list of search terms described above.
- language: the Google Maps language code.
`;
}
