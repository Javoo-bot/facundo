// Enrichment orchestration — the network/render/LLM layer around the pure
// extractors. Port of ingest/enrich.py's crawl + enrich_florist flow.
import { isLlmOutage, type LlmClient } from "./openrouter";
import {
  USER_AGENT,
  FETCH_TIMEOUT_MS,
  MAX_PAGES_PER_FLORIST,
  MAX_PAGE_BYTES,
  MODEL_FOR_CALL,
  STRONG_ECOMMERCE_SIGNAL_KEYS,
  ECOMMERCE_HTML_EXCERPT_CHARS,
  type CallType,
} from "./config";
import {
  isSocialUrl,
  looksLoginWalled,
  isThinPage,
  collectInternalLinks,
  rankLinks,
  extractSocialLinks,
  extractBioLinkCandidates,
  detectEcommerceSignals,
  extractCandidateEmails,
  extractCandidatePhones,
  buildFocusedContext,
  extractTextForOwner,
} from "./extractors";
import {
  structured,
  ECOMMERCE_SCHEMA,
  EMAIL_SCHEMA,
  PHONE_SCHEMA,
  OWNER_SCHEMA,
  type StructuredSchema,
} from "./llm";
import { WORKER_AGENTS } from "./agents.generated";
import {
  ecommerceClassificationPrompt,
  emailExtractionPrompt,
  phoneExtractionPrompt,
  ownerInfoPrompt,
} from "./prompts";
import { renderPage } from "./browserPool";
import type { ApiUsage } from "./usage";
import type {
  Env,
  ScrapedFlorist,
  EnrichmentResult,
  EnrichmentAiContext,
  EcommerceClassification,
  EmailExtraction,
  PhoneExtraction,
  OwnerInfo,
} from "./types";

export interface RecordedUsage {
  callType: CallType;
  model: string;
  usage: ApiUsage;
}

type Pages = Record<string, string>;

// --- fetching + rendering -------------------------------------------------

/** Read `resp`'s body up to `maxBytes`, decoding what was received even if
 * the stream is cut short — a page-builder site's early markup (head/nav/
 * hero/footer, where contact info overwhelmingly lives) is still usable even
 * when its trailing megabytes of embedded JS/JSON state get truncated. See
 * MAX_PAGE_BYTES. Reads by stream rather than trusting Content-Length (which
 * chunked-encoding responses may omit or misreport). */
export async function readBodyCapped(resp: Response, maxBytes: number): Promise<string | null> {
  if (!resp.body) return (await resp.text()) || null;
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode(); // flush any pending multi-byte sequence
        break;
      }
      // Slice AT the byte boundary rather than decode-then-check: a small/
      // fast response can arrive as a single chunk far bigger than maxBytes,
      // and decoding it whole before noticing the overrun would cap nothing.
      // stream:true (not false) here: an arbitrary byte offset can land mid
      // multi-byte character, and `false` would force that dangling partial
      // into a U+FFFD replacement char. `true` just holds it back silently —
      // losing the last character at the boundary is fine; corrupting the
      // ones before it with a replacement char is not.
      const remaining = maxBytes - received;
      if (value.byteLength >= remaining) {
        text += decoder.decode(value.subarray(0, Math.max(0, remaining)), { stream: true });
        await reader.cancel();
        break;
      }
      received += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text || null;
}

async function fetchStatic(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": USER_AGENT },
    });
    if (resp.status >= 400) return null;
    return await readBodyCapped(resp, MAX_PAGE_BYTES);
  } catch {
    return null;
  }
}

/** Static-first, render-on-thin/missing. Returns [html, method]. */
async function fetchOrRender(env: Env, url: string): Promise<[string | null, string]> {
  const staticHtml = await fetchStatic(url);
  if (staticHtml && !isThinPage(staticHtml)) return [staticHtml, "static"];
  const rendered = await renderPage(env, url);
  if (rendered) return [rendered, "rendered"];
  if (staticHtml) return [staticHtml, "static-thin"];
  return [null, "unreachable"];
}

// --- bounded internal-link crawl ------------------------------------------

async function crawlSite(
  env: Env,
  websiteUrl: string,
  maxPages: number = MAX_PAGES_PER_FLORIST,
  followSocialFallback = true
): Promise<{ pages: Pages; notes: string[] }> {
  const notes: string[] = [];
  const pages: Pages = {};
  const methods: Record<string, string> = {};
  if (maxPages <= 0) return { pages, notes };

  const [homeHtml, homeMethod] = await fetchOrRender(env, websiteUrl);
  if (!homeHtml) {
    notes.push(`Homepage ${websiteUrl} was unreachable (static and headless both failed).`);
    return { pages, notes };
  }
  pages[websiteUrl] = homeHtml;
  methods[websiteUrl] = homeMethod;

  const candidates = rankLinks(collectInternalLinks(homeHtml, websiteUrl));
  const budget = maxPages - 1;
  for (const link of candidates.slice(0, budget)) {
    const [html, method] = await fetchOrRender(env, link);
    if (html) {
      pages[link] = html;
      methods[link] = method;
    }
  }
  notes.push(
    `Crawled ${Object.keys(pages).length} page(s) (cap ${maxPages}): ` +
      Object.keys(pages)
        .map((u) => `${u} [${methods[u]}]`)
        .join(", ")
  );

  // Escalation: nothing rendered yet and no signal anywhere → force-render home.
  const nothingRendered = !Object.values(methods).some((m) => m === "rendered");
  if (nothingRendered) {
    const hasEmail = extractCandidateEmails(pages).length > 0;
    const hasPhone = extractCandidatePhones(pages).length > 0;
    const hasEcom = Object.keys(detectEcommerceSignals(pages)).length > 0;
    if (!hasEmail && !hasPhone && !hasEcom) {
      const renderedHome = await renderPage(env, websiteUrl);
      if (renderedHome && renderedHome !== homeHtml) {
        pages[websiteUrl] = renderedHome;
        methods[websiteUrl] = "rendered (escalated: no signals found statically)";
        notes.push("Re-rendered homepage (no email/phone/ecommerce signal found statically).");
        const remaining = maxPages - Object.keys(pages).length;
        if (remaining > 0) {
          const extra = rankLinks(collectInternalLinks(renderedHome, websiteUrl)).filter(
            (u) => !(u in pages)
          );
          for (const link of extra.slice(0, remaining)) {
            const [html, method] = await fetchOrRender(env, link);
            if (html) {
              pages[link] = html;
              methods[link] = method;
            }
          }
          if (extra.slice(0, remaining).length) {
            notes.push(`Fetched ${Math.min(extra.length, remaining)} additional page(s) from rendered nav.`);
          }
        }
      }
    }
  }

  // Social fallback: still zero emails and budget left → follow first social link.
  if (followSocialFallback && Object.keys(pages).length < maxPages && extractCandidateEmails(pages).length === 0) {
    const socialLinks: string[] = [];
    const seen = new Set<string>();
    for (const html of Object.values(pages)) {
      for (const s of extractSocialLinks(html, websiteUrl)) {
        if (!seen.has(s)) {
          seen.add(s);
          socialLinks.push(s);
        }
      }
    }
    if (socialLinks.length > 0) {
      const socialLink = socialLinks[0];
      notes.push(`No email found on-site; following social profile ${socialLink}.`);
      const sub = await crawlSocialSite(env, socialLink, maxPages - Object.keys(pages).length);
      Object.assign(pages, sub.pages);
      notes.push(...sub.notes);
    }
  }

  return { pages, notes };
}

async function crawlSocialSite(
  env: Env,
  socialUrl: string,
  maxPages: number = MAX_PAGES_PER_FLORIST
): Promise<{ pages: Pages; notes: string[] }> {
  const notes: string[] = [];
  const pages: Pages = {};
  if (maxPages <= 0) return { pages, notes };

  const rendered = await renderPage(env, socialUrl);
  if (!rendered) {
    notes.push(`${socialUrl} is a social/link-in-bio profile; headless render failed (unreachable or blocked).`);
    return { pages, notes };
  }
  pages[socialUrl] = rendered;
  notes.push(
    looksLoginWalled(rendered)
      ? `${socialUrl} rendered but looks login-walled/blocked.`
      : `${socialUrl} rendered successfully.`
  );

  const remaining = maxPages - Object.keys(pages).length;
  if (remaining <= 0) return { pages, notes };

  const bioLinks = extractBioLinkCandidates(rendered, socialUrl);
  if (bioLinks.length === 0) {
    notes.push(`No outbound link-in-bio found on ${socialUrl}.`);
    return { pages, notes };
  }
  const bioLink = bioLinks[0];
  notes.push(`Following link-in-bio ${bioLink}.`);
  const sub = await crawlSite(env, bioLink, remaining, false);
  Object.assign(pages, sub.pages);
  notes.push(...sub.notes);
  if (Object.keys(sub.pages).length === 0) notes.push(`Link-in-bio target ${bioLink} was unreachable.`);
  return { pages, notes };
}

// --- LLM call wrappers --------------------------------------------------

/** One florist's model calls: what each was shown (for
 * florists.enrichment_ai_context) and what it cost. */
interface EnrichCalls {
  llm: LlmClient;
  placeId: string;
  usages: RecordedUsage[];
  shown: EnrichmentAiContext["calls"];
}

async function ask<T>(
  c: EnrichCalls,
  callType: "ecommerce" | "email" | "phone" | "owner",
  prompt: string,
  schema: StructuredSchema,
  maxTokens: number
): Promise<T> {
  const model = MODEL_FOR_CALL[callType];
  c.shown.push({ name: callType, model, prompt });
  const { parsed, usage } = await structured<T>(c.llm, model, prompt, schema, maxTokens, {
    agent: "sherlock",
    name: callType,
    sessionId: c.placeId,
  });
  c.usages.push({ callType, model, usage });
  return parsed;
}

const classifyEcommerce = (c: EnrichCalls, combinedHtml: string) =>
  ask<EcommerceClassification>(
    c, "ecommerce", ecommerceClassificationPrompt(combinedHtml.slice(0, ECOMMERCE_HTML_EXCERPT_CHARS)), ECOMMERCE_SCHEMA, 1024
  );

const extractEmail = (c: EnrichCalls, candidates: string[], context: string) =>
  ask<EmailExtraction>(
    c, "email", emailExtractionPrompt(candidates.join("\n") || "(none found)", context.slice(0, 4000)), EMAIL_SCHEMA, 512
  );

const extractPhone = (c: EnrichCalls, candidates: string[], context: string) =>
  ask<PhoneExtraction>(
    c, "phone", phoneExtractionPrompt(candidates.join("\n") || "(none found)", context.slice(0, 4000)), PHONE_SCHEMA, 512
  );

const extractOwnerInfo = (c: EnrichCalls, text: string) => ask<OwnerInfo>(c, "owner", ownerInfoPrompt(text), OWNER_SCHEMA, 256);

// --- per-florist enrichment ------------------------------------------------

const NO_WEBSITE: EnrichmentResult = {
  has_website: false,
  is_ecommerce: null,
  ecommerce_signals: null,
  email: null,
  phone_web: null,
  owner_name: null,
  shop_highlight: null,
  content_language: null,
  enrichment_notes: "No website on Maps listing — skipped enrichment.",
  enrichment_ai_context: null,
};

/** Result used when a florist's enrichment exceeds its wall-clock budget or
 * raises. Mirrors ingest/enrich.py::_FAILED_ENRICHMENT — best-effort: one
 * florist's failure never blocks the rest of the city. */
export const FAILED_ENRICHMENT: EnrichmentResult = {
  has_website: true,
  is_ecommerce: null,
  ecommerce_signals: null,
  email: null,
  phone_web: null,
  owner_name: null,
  shop_highlight: null,
  content_language: null,
  enrichment_notes: "Enrichment exceeded its time budget or raised — skipped for this florist.",
  enrichment_ai_context: null,
};

/** Overall per-florist wall-clock budget (ms). Beyond this the florist is
 * dropped to FAILED_ENRICHMENT so a single hung site/LLM/fetch can't stall the
 * whole city's Workflow. */
export const ENRICH_FLORIST_TIMEOUT_MS = 90_000;

export async function enrichFlorist(
  florist: ScrapedFlorist,
  llm: LlmClient,
  env: Env,
  // Optional external sink: LLM usages are pushed here as each call completes,
  // so a caller that abandons this promise on timeout still sees the cost that
  // was already incurred. Defaults to a fresh array.
  usagesSink?: RecordedUsage[]
): Promise<{ result: EnrichmentResult; usages: RecordedUsage[] }> {
  const usages: RecordedUsage[] = usagesSink ?? [];
  const website = florist.website_url;
  if (!website) return { result: { ...NO_WEBSITE }, usages };

  const { pages, notes } = isSocialUrl(website)
    ? await crawlSocialSite(env, website)
    : await crawlSite(env, website);

  if (Object.keys(pages).length === 0) {
    return {
      result: {
        has_website: true,
        is_ecommerce: null,
        ecommerce_signals: null,
        email: null,
        phone_web: null,
        owner_name: null,
        shop_highlight: null,
        content_language: null,
        enrichment_notes: notes.join(" "),
        enrichment_ai_context: null,
      },
      usages,
    };
  }

  const combinedHtml = Object.values(pages).join("\n");
  const calls: EnrichCalls = { llm, placeId: florist.place_id, usages, shown: [] };

  // Ecommerce.
  const signals: Record<string, unknown> = detectEcommerceSignals(pages);
  if (florist.maps_online_order) signals.maps_online_order = true;
  let isEcommerce: boolean | null;
  if (STRONG_ECOMMERCE_SIGNAL_KEYS.some((k) => k in signals)) {
    isEcommerce = true;
    notes.push(`Ecommerce: rule signals matched ${JSON.stringify(signals)}.`);
  } else {
    try {
      const c = await classifyEcommerce(calls, combinedHtml);
      isEcommerce = c.is_ecommerce;
      signals.llm_confidence = c.confidence;
      signals.llm_reasoning = c.reasoning;
      notes.push(`Ecommerce: LLM classified is_ecommerce=${c.is_ecommerce} (confidence ${c.confidence.toFixed(2)}).`);
    } catch (e) {
      if (isLlmOutage(e)) throw e; // see the Email leg
      isEcommerce = null;
      notes.push(`Ecommerce: LLM classification failed (${e instanceof Error ? e.message : String(e)}).`);
    }
  }

  // Email.
  let email: string | null = null;
  const emailCandidates = extractCandidateEmails(pages);
  if (emailCandidates.length > 0) {
    try {
      const ctx = buildFocusedContext(pages, emailCandidates);
      const r = await extractEmail(calls, emailCandidates, ctx);
      email = r.email;
      notes.push(
        `Email: ${emailCandidates.length} candidate(s) → ${email ?? "none (no genuine primary email)"} (confidence ${r.confidence.toFixed(2)}).`
      );
    } catch (e) {
      // An outage is not a finding. Recording it as one is what produced 1,065
      // rows whose notes talk about billing and whose email is null — and which
      // read, downstream, exactly like "we looked and there was nothing".
      if (isLlmOutage(e)) throw e;
      notes.push(`Email: extraction failed (${e instanceof Error ? e.message : String(e)}).`);
    }
  } else {
    notes.push("No email candidates found (regex, mailto:, JSON-LD, or de-obfuscation).");
  }

  // Phone.
  let phoneWeb: string | null = null;
  const phoneCandidates = extractCandidatePhones(pages);
  if (phoneCandidates.length > 0) {
    try {
      const ctx = buildFocusedContext(pages, phoneCandidates);
      const r = await extractPhone(calls, phoneCandidates, ctx);
      phoneWeb = r.phone;
      notes.push(
        `Phone: ${phoneCandidates.length} candidate(s) → ${phoneWeb ?? "none (no genuine primary phone)"} (confidence ${r.confidence.toFixed(2)}).`
      );
    } catch (e) {
      // An outage is not a finding. Recording it as one is what produced 1,065
      // rows whose notes talk about billing and whose email is null — and which
      // read, downstream, exactly like "we looked and there was nothing".
      if (isLlmOutage(e)) throw e;
      notes.push(`Phone: extraction failed (${e instanceof Error ? e.message : String(e)}).`);
    }
  } else {
    notes.push("No phone candidates found via regex.");
  }

  // Owner info.
  let ownerName: string | null = null;
  let shopHighlight: string | null = null;
  let contentLanguage: string | null = null;
  const ownerText = extractTextForOwner(pages);
  if (ownerText) {
    try {
      const o = await extractOwnerInfo(calls, ownerText);
      ownerName = o.owner_name;
      shopHighlight = o.shop_highlight;
      contentLanguage = o.content_language;
      notes.push(
        `Owner: name=${ownerName ?? "null"}, highlight=${shopHighlight ?? "null"}, content_language=${contentLanguage ?? "undetermined"}.`
      );
    } catch (e) {
      if (isLlmOutage(e)) throw e; // see the Email leg
      notes.push(`Owner: extraction failed (${e instanceof Error ? e.message : String(e)}).`);
    }
  } else {
    notes.push("No contact/about-style page content found for owner-info extraction.");
  }

  return {
    result: {
      has_website: true,
      is_ecommerce: isEcommerce,
      ecommerce_signals: signals,
      email,
      phone_web: phoneWeb,
      owner_name: ownerName,
      shop_highlight: shopHighlight,
      content_language: contentLanguage,
      enrichment_notes: notes.join(" "),
      enrichment_ai_context: calls.shown.length
        ? { agent: "sherlock", rulesHash: WORKER_AGENTS.sherlock.rulesHash, calls: calls.shown }
        : null,
    },
    usages,
  };
}
