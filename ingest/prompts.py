"""Claude prompts + structured-output response models for the enrichment
and outreach-drafting steps.

Model: claude-sonnet-5 (see CLAUDE.md — do NOT use claude-sonnet-4-6, the
brief's outdated ID). Structured-output calls use `client.messages.parse(
output_format=<Model>)` and read `response.parsed_output`. Free-form calls
(the outreach draft) use plain `client.messages.create(...)` and no
response model is needed.
"""

from pydantic import BaseModel


class EcommerceClassification(BaseModel):
    is_ecommerce: bool
    confidence: float
    reasoning: str


class EmailExtraction(BaseModel):
    email: str | None
    confidence: float


class PhoneExtraction(BaseModel):
    phone: str | None
    confidence: float


class OwnerInfo(BaseModel):
    owner_name: str | None
    shop_highlight: str | None
    content_language: str | None


class RelevanceClassification(BaseModel):
    is_florist: bool
    confidence: float
    reasoning: str


class KeywordSuggestion(BaseModel):
    keywords: list[str]
    language: str


ECOMMERCE_CLASSIFICATION_PROMPT = """You are classifying whether a florist's \
website supports online ordering (ecommerce) — i.e. a customer can select \
products and pay online, as opposed to a purely informational "brochure" \
site with a phone number and address.

Rule-based signals (platform names, cart/checkout links, product schema) \
did not conclusively match on this site, so you're the fallback. Look at \
the HTML below and decide:

- is_ecommerce: true if there is a clear way to buy something online \
  (a cart, checkout flow, "add to cart" style buttons, priced product \
  listings with a purchase action). False if it's clearly just \
  informational/contact-only. If you are genuinely unsure, make your best \
  call but reflect the uncertainty in `confidence`.
- confidence: 0.0-1.0, how sure you are.
- reasoning: one or two sentences on what you saw (or didn't see).

Do not guess based on the business type alone — judge only from the HTML.

HTML (may be truncated):
---
{html_excerpt}
---
"""

EMAIL_EXTRACTION_PROMPT = """You are extracting the PRIMARY business contact \
email for a florist from candidate email addresses found on their website.

Candidate emails found via regex:
---
{candidates}
---

Surrounding page context (may help disambiguate which email is the real \
business contact vs. a CDN/tracking/placeholder address):
---
{context}
---

Rules:
- Prefer an address that looks like the shop's own contact/order email \
  (e.g. info@, orders@, hello@, or the shop's own domain).
- Skip noreply@/no-reply@ addresses, obvious CDN/tracking/analytics \
  addresses, and platform-hosting addresses like anything@wixsite.com or \
  similar builder subdomains that aren't the business's real domain.
- CRITICAL — skip any address that belongs to a NETWORK, FRANCHISE, CHAIN \
  HEAD OFFICE or TRADE ASSOCIATION rather than to this individual shop. The \
  page may be a shop's profile on a florist network or association site, in \
  which case the only address on it is the organisation's, not the shop's. \
  Tell-tale signs: a customer-service or head-office mailbox \
  (service.consommateurs@, service.clients@, zentrale@, siege@, \
  info@<association>), text describing a network of members/outlets or a \
  "find a florist near you" directory, or an address whose local part names \
  the organisation rather than this shop. A shop-specific address on a \
  network's domain (e.g. paris15-lecourbe@chaine-fleurs.com) is fine — it \
  reaches THIS outlet. Reaching a head office does not reach this shop, and \
  emailing it about one shop's order is worse than sending nothing.
- If none of the candidates look like a genuine primary business email, \
  return null for email — do not guess or fabricate one. A null is the \
  CORRECT answer whenever the only candidates belong to somebody other than \
  this shop.
- confidence: 0.0-1.0, how sure you are this is the right primary email.
"""

PHONE_EXTRACTION_PROMPT = """You are extracting the PRIMARY business phone \
number for a florist from candidate phone numbers found on their website.

Candidate phone numbers found via regex:
---
{candidates}
---

Surrounding page context:
---
{context}
---

Rules:
- Prefer a number that reads as the shop's main contact/order line, not a \
  fax number, a third-party delivery partner's number, or an unrelated \
  number that happens to appear on the page.
- If none of the candidates look like a genuine primary business phone \
  number, return null for phone — do not guess or fabricate one.
- confidence: 0.0-1.0, how sure you are this is the right primary phone \
  number.
"""

OWNER_INFO_PROMPT = """You are analyzing a small florist business using text \
pulled from their /about, /team, or /impressum page.

Page text (may be truncated):
---
{text}
---

Return three things:

- owner_name: the owner or founder's name, but ONLY if the text clearly \
  identifies someone as the owner, founder, or proprietor (e.g. "Founded by \
  Jane Smith", "Owner: John Doe") AND it is a real personal name. Do NOT \
  return a name that is merely mentioned (a staff member, a customer \
  testimonial, a delivery driver), and do NOT return a brand/shop name. \
  null is the correct answer more often than not for small business sites — \
  if the text doesn't clearly name a real owner/founder, return null. Do not \
  guess.

- shop_highlight: ONE short, factual, genuinely distinctive detail the shop \
  states about itself — e.g. years in business ("family-run since 1998"), a \
  signature specialty ("known for large-scale wedding installations"), or a \
  notable award/recognition. Draw it ONLY from the page text. Keep it to a \
  short phrase. Return null if the text says nothing genuinely distinctive — \
  do not invent, and do not pad with generic filler like "offers beautiful \
  flowers".

- content_language: the BCP-47 language code of the shop's OWN website text \
  (e.g. "es", "ca", "de", "pt-BR"). Return null if there is too little text \
  to tell.
"""

RELEVANCE_CLASSIFICATION_PROMPT = """You are judging whether a Google Maps place \
that matched a florist-related search term is actually a florist / flower shop \
business, as opposed to some other business that happened to match the search \
(a supermarket with a flower section, a gift shop, a garden center, a flower \
wholesaler that doesn't serve retail walk-in customers, a wedding/event planner, \
etc.).

Google's own category for this place did not clearly match florist-style \
categories, so you're the fallback judge.

Name: {name}
Address: {address}
Google Maps category: {category_name}
All Google Maps categories: {categories}
Rating: {rating} from {review_count} reviews

Decide:
- is_florist: true if this is a real florist / flower shop — a business whose \
  primary purpose is selling or arranging cut flowers, bouquets, or floral \
  arrangements for retail customers. False for any other business type, even one \
  that sells some flowers as a side offering.
- A "false" here is PERMANENT — this place will be dropped and never looked at \
  again. If you are genuinely unsure, prefer true (keep it) rather than guessing \
  false, and reflect your uncertainty in confidence instead of the boolean.
- confidence: 0.0-1.0, how sure you are.
- reasoning: one short sentence on what you saw (or didn't see).
"""

KEYWORD_SUGGESTION_PROMPT = """You are helping a florist-discovery tool search \
Google Maps for florists in a specific country using local-language search terms. \
English-only queries like "florist" under-collect results in non-English-speaking \
countries because Google Maps matches on the language people actually search in \
(e.g. "floristeria"/"floristería" surface different, additional results than \
"florist" would in Spain).

Country: {country}

Give the common local-language search terms people would use to find a florist / \
flower shop on Google Maps in this country:
- Include the standard term(s) in the country's main official/majority language(s).
- Include common variant spellings (with/without accents, common misspellings that \
  still work well as Maps search terms).
- If the country has a meaningful regional/co-official language spoken by a large \
  population (e.g. Catalan and Basque in Spain, French/Flemish in Belgium, etc.), \
  include the local-language term(s) for those regions too, so searches in those \
  areas aren't missed.
- Always include the plain English "florist" as a fallback term.
- Keep the list short and high-signal — roughly 3 to 8 terms, not an exhaustive \
  dictionary.

Also give the Google Maps `language` parameter code most appropriate for search \
results in this country's dominant language (a two-letter code, or a locale like \
"pt-BR" when that distinction matters).

Return:
- keywords: the list of search terms described above.
- language: the Google Maps language code.
"""

# NOTE: no longer used by the ingest CLI — outreach drafting moved on-demand to
# the dashboard. This is kept as the reference the TS port mirrors verbatim:
# dashboard/lib/draftEmail.ts::buildDraftPrompt. Keep the two in sync.
EMAIL_DRAFT_PROMPT = """You are writing a warm, genuine outreach email from \
Facundo — a global flower-delivery network that partners with local \
florists — to a florist we found while researching {city}. It should read \
like a real person who looked at this specific shop wrote it, NOT a mail \
merge.

Language: write the entire email in this language (BCP-47 code): \
{target_language}. If that code is NOT English, then after the email add a \
line containing only "———" and below it a faithful English version of the \
same email (its subject included). If it IS English, output only the one \
email — no translation, no divider.

Format: begin the output with a subject line in exactly this form — the \
literal ASCII label "Subject:" (always this exact English word, never \
translated or localized), a space, then the subject text itself written in \
the target language — then a blank line, then the greeting and body. When you \
add the English version, it too begins with its own "Subject:" line. Put \
nothing before the first "Subject:" line.

Greeting: {greeting_instruction}

Opening: {opening_instruction}

Then, in 2-3 short sentences: introduce Facundo as a global flower-delivery \
network connecting local florists with customers worldwide, say we're building \
a partner network across Europe, and that you'd love to share details. Include \
exactly one call to action inviting a reply or a short call. Sign off as \
"The Facundo Partnerships Team" (translate the sign-off into the target \
language too).

Keep each language version under ~120 words, warm but professional, one CTA, \
no literal placeholders (never output text in curly braces), no invented \
facts about the shop. Return only the email(s), nothing else.

Reference facts (do not restate mechanically — weave in naturally):
- Shop name: {name}
- City: {city}
- Rating: {rating} from {review_count} reviews
"""
