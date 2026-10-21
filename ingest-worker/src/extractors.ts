// Pure (no-network, no-LLM, no-browser) HTML extraction helpers, ported
// line-for-line in behavior from ingest/enrich.py. These are the correctness
// backbone of enrichment (email/phone/ecommerce-signal/link scoring) — see
// that file for the canonical reference and inline commentary on *why* each
// heuristic exists. Only the synchronous parsing/regex helpers live here;
// async orchestration (fetch/render/crawl/Claude calls) is ported elsewhere.

import * as cheerio from "cheerio";
import {
  ABOUT_PATH_KEYWORDS,
  CONTACT_PATH_KEYWORDS,
  CONTEXT_MAX_CHARS,
  CONTEXT_WINDOW,
  DEOBFUSCATE_PATTERNS,
  ECOMMERCE_CART_SIGNALS,
  ECOMMERCE_NETWORK_MARKERS,
  ECOMMERCE_PLATFORM_SIGNALS,
  ECOMMERCE_SHOP_PATH_SIGNALS,
  EMAIL_FULLMATCH_REGEX,
  CF_EMAIL_REGEX,
  EMAIL_REGEX,
  LINK_PRIORITY_KEYWORDS,
  LOGIN_WALL_MARKERS,
  MAILTO_REGEX,
  MAX_CANDIDATES,
  NON_BIO_LINK_HOSTNAMES,
  OBFUSCATED_EMAIL_REGEX,
  OWNER_TEXT_PER_PAGE_CHARS,
  OWNER_TEXT_TOTAL_CHARS,
  PHONE_MAX_DIGITS,
  PHONE_MIN_DIGITS,
  PHONE_REGEX,
  REDIRECT_WRAPPER_HOSTNAMES,
  SHALLOW_PATH_BONUS,
  SKIP_EMAIL_DOMAIN_SUFFIXES,
  SKIP_EMAIL_LOCAL_PREFIXES,
  SKIP_LINK_EXTENSIONS,
  SKIP_LINK_SCHEMES,
  SOCIAL_HOSTNAMES,
  TEL_HREF_REGEX,
  THIN_HTML_BYTES,
  THIN_TEXT_CHARS,
  WHATSAPP_PHONE_REGEX,
} from "./config";

// --------------------------------------------------------------------------
// get_text(separator=" ", strip=...) replica
//
// Per the porting brief: collect all text nodes (document order) and join
// with a single space; when `strip` is requested, trim the WHOLE joined
// result once at the end (not per-node) — this is the exact algorithm
// specified for this port, used consistently at every call site below.
// --------------------------------------------------------------------------

function collectTextNodes(node: unknown, out: string[]): void {
  if (!node || typeof node !== "object") return;
  const n = node as { type?: string; data?: string; children?: unknown[] };
  if (n.type === "text") {
    out.push(n.data ?? "");
    return;
  }
  if (Array.isArray(n.children)) {
    for (const child of n.children) {
      collectTextNodes(child, out);
    }
  }
}

export function getText($: cheerio.CheerioAPI, opts?: { strip?: boolean }): string {
  const out: string[] = [];
  collectTextNodes($.root().get(0), out);
  const joined = out.join(" ");
  return opts?.strip ? joined.trim() : joined;
}

// --------------------------------------------------------------------------
// Social / link-in-bio handling
// --------------------------------------------------------------------------

function stripWww(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

function matchesHostList(host: string, hosts: readonly string[]): boolean {
  return hosts.some((h) => host === h || host.endsWith("." + h));
}

export function isSocialUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const host = stripWww(new URL(url).hostname);
    return matchesHostList(host, SOCIAL_HOSTNAMES);
  } catch {
    return false;
  }
}

export function looksLoginWalled(html: string | null): boolean {
  if (!html) return true;
  const lower = html.toLowerCase();
  return LOGIN_WALL_MARKERS.some((marker) => lower.includes(marker)) || isThinPage(html);
}

export function unwrapRedirectLink(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = stripWww(parsed.hostname);
  if (REDIRECT_WRAPPER_HOSTNAMES.some((h) => h === host)) {
    const target = parsed.searchParams.get("u");
    if (target) {
      try {
        return decodeURIComponent(target);
      } catch {
        return target;
      }
    }
  }
  return url;
}

function hrefIsSkippable(href: string): boolean {
  return !href || SKIP_LINK_SCHEMES.some((scheme) => href.startsWith(scheme));
}

export function extractSocialLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const links: string[] = [];
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (hrefIsSkippable(href)) return;

    let absoluteUrl: URL;
    try {
      absoluteUrl = new URL(href, baseUrl);
    } catch {
      return;
    }
    const absolute = absoluteUrl.toString();
    if (!isSocialUrl(absolute)) return;

    absoluteUrl.hash = "";
    const normalized = absoluteUrl.toString();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    links.push(normalized);
  });
  return links;
}

export function extractBioLinkCandidates(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const links: string[] = [];
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (hrefIsSkippable(href)) return;

    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      return;
    }
    const absolute = unwrapRedirectLink(resolved.toString());

    let parsed: URL;
    try {
      parsed = new URL(absolute);
    } catch {
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    if (isSocialUrl(absolute)) return;

    const host = stripWww(parsed.hostname);
    if (matchesHostList(host, NON_BIO_LINK_HOSTNAMES)) return;

    const path = parsed.pathname.toLowerCase();
    if (SKIP_LINK_EXTENSIONS.some((ext) => path.endsWith(ext))) return;

    parsed.hash = "";
    const normalized = parsed.toString();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    links.push(normalized);
  });
  return links;
}

// --------------------------------------------------------------------------
// Fetching + headless rendering (thin-page heuristic only — pure)
// --------------------------------------------------------------------------

export function isThinPage(html: string | null): boolean {
  if (!html || html.length < THIN_HTML_BYTES) return true;
  const $ = cheerio.load(html);
  const text = getText($, { strip: true });
  const links = $("a[href]");
  return text.length < THIN_TEXT_CHARS || links.length === 0;
}

// --------------------------------------------------------------------------
// Bounded internal-link crawl
// --------------------------------------------------------------------------

export function collectInternalLinks(html: string, baseUrl: string): string[] {
  let baseParsed: URL;
  try {
    baseParsed = new URL(baseUrl);
  } catch {
    return [];
  }
  const baseNetloc = stripWww(baseParsed.hostname);
  const baseNormalizedUrl = new URL(baseUrl);
  baseNormalizedUrl.hash = "";
  baseNormalizedUrl.search = "";
  const baseNormalized = baseNormalizedUrl.toString().replace(/\/+$/, "");

  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const links: string[] = [];
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (hrefIsSkippable(href)) return;

    let absolute: URL;
    try {
      absolute = new URL(href, baseUrl);
    } catch {
      return;
    }
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") return;

    const netloc = stripWww(absolute.hostname);
    if (netloc !== baseNetloc) return;

    const path = absolute.pathname.toLowerCase();
    if (SKIP_LINK_EXTENSIONS.some((ext) => path.endsWith(ext))) return;

    absolute.hash = "";
    absolute.search = "";
    const normalized = absolute.toString();
    if (normalized.replace(/\/+$/, "") === baseNormalized || seen.has(normalized)) return;
    seen.add(normalized);
    links.push(normalized);
  });
  return links;
}

export function scoreLink(url: string): number {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    path = "";
  }
  let score = 0;
  for (const [keyword, weight] of Object.entries(LINK_PRIORITY_KEYWORDS)) {
    if (path.includes(keyword) && weight > score) score = weight;
  }
  if (score === 0) {
    const segments = path.split("/").filter((s) => s.length > 0);
    if (segments.length === 1) score = SHALLOW_PATH_BONUS;
  }
  return score;
}

export function rankLinks(links: string[]): string[] {
  // Precompute [url, score] pairs before sorting: avoids recomputing
  // scoreLink per comparison and, combined with JS's stable Array.sort,
  // guarantees stable order among ties (mirrors Python's sorted()).
  const scored = links.map((url) => ({ url, score: scoreLink(url) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.url);
}

// --------------------------------------------------------------------------
// Rule-based detection
// --------------------------------------------------------------------------

export function detectEcommerceSignals(pages: Record<string, string>): Record<string, unknown> {
  const signals: Record<string, unknown> = {};
  const rulePages = Object.entries(pages).filter(([url]) => !isSocialUrl(url));
  const combined = rulePages
    .map(([, html]) => html)
    .join("\n")
    .toLowerCase();

  for (const platform of ECOMMERCE_PLATFORM_SIGNALS) {
    if (combined.includes(platform)) {
      signals.platform = platform;
      break;
    }
  }

  for (const cartSignal of ECOMMERCE_CART_SIGNALS) {
    if (combined.includes(cartSignal)) {
      signals.cart_signal = cartSignal;
      break;
    }
  }

  if (combined.includes("schema.org/product")) {
    signals.product_schema = true;
  }

  for (const [markerText, network] of ECOMMERCE_NETWORK_MARKERS) {
    if (combined.includes(markerText)) {
      signals.network_marker = network;
      break;
    }
  }

  if (
    rulePages.some(([url]) => ECOMMERCE_SHOP_PATH_SIGNALS.some((kw) => url.toLowerCase().includes(kw)))
  ) {
    signals.shop_page_crawled = true;
  }

  return signals;
}

/** Reverses Cloudflare's email obfuscation (config.ts::CF_EMAIL_REGEX).
 *
 * The payload is hex; its FIRST byte is the XOR key for every byte after it.
 * That is the whole algorithm — the same one Cloudflare's own client-side
 * snippet runs, reimplemented here because our crawler doesn't execute it.
 *
 * Returns null for anything that doesn't decode to something email-shaped,
 * rather than letting mojibake through as a candidate. */
export function decodeCloudflareEmail(hex: string): string | null {
  if (hex.length < 4 || hex.length % 2 !== 0) return null;
  const key = Number.parseInt(hex.slice(0, 2), 16);
  if (Number.isNaN(key)) return null;
  let out = "";
  for (let i = 2; i < hex.length; i += 2) {
    const byte = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) return null;
    out += String.fromCharCode(byte ^ key);
  }
  return EMAIL_FULLMATCH_REGEX.test(out) ? out : null;
}

/** Reverses WordPress core's `antispambot()` email cloaking: the address
 * spelled out as per-character HTML numeric entities (`&#109;` / `&#x6d;`,
 * mixed), sometimes with the href target ALSO percent-encoded underneath
 * that (`antispambot()` alternates forms per character — observed on
 * blumendemo.ch and flori-demo.ro). Both render plainly to a human and contain
 * no literal "@" for a raw-html regex to find. A no-op string in, string
 * out — safe to run unconditionally and re-scan with the normal regexes.
 *
 * Deliberately narrower than Python's `html.unescape`: only numeric
 * references (decimal `&#NNN;` / hex `&#xHH;`), since that's the entire
 * antispambot() alphabet — named entities (&amp;/&nbsp;) never carry an
 * obfuscated character and are left alone. KEEP IN STEP with
 * enrich.py::deobfuscate_entity_encoded_email. */
export function deobfuscateEntityEncodedEmail(html: string): string {
  const withEntitiesDecoded = html
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec: string) => String.fromCharCode(Number.parseInt(dec, 10)));
  try {
    return decodeURIComponent(withEntitiesDecoded);
  } catch {
    return withEntitiesDecoded; // stray "%" not part of valid percent-encoding
  }
}

export function deobfuscate(span: string): string {
  let normalized = span;
  for (const [pattern, repl] of DEOBFUSCATE_PATTERNS) {
    normalized = normalized.replace(pattern, repl);
  }
  return normalized.replace(/\s+/g, "");
}

function loadJsonLdEmails(html: string): string[] {
  const $ = cheerio.load(html);
  const results: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    try {
      const data = JSON.parse(raw);
      results.push(...findEmailsInJson(data));
    } catch {
      // Swallow malformed JSON-LD — mirrors Python's except (JSONDecodeError, TypeError): continue.
    }
  });
  return results;
}

function loadJsonLdPhones(html: string): string[] {
  const $ = cheerio.load(html);
  const results: string[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text();
    try {
      const data = JSON.parse(raw);
      results.push(...findPhonesInJson(data));
    } catch {
      // Swallow malformed JSON-LD.
    }
  });
  return results;
}

export function extractCandidateEmails(pages: Record<string, string>): string[] {
  const found: string[] = [];

  const addAll = (candidates: Iterable<string>): void => {
    for (const candidate of candidates) {
      const lower = candidate.toLowerCase();
      if (SKIP_EMAIL_DOMAIN_SUFFIXES.some((suffix) => lower.endsWith(suffix))) continue;
      if (SKIP_EMAIL_LOCAL_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
      // A retina-asset filename ("shadow@2x.png", "logo@2x.jpg") is
      // "local@domain.tld"-shaped enough to pass EMAIL_REGEX — reuse the same
      // extension list link-collection already skips for the same reason
      // (real found case: perfume-demo.net's CSS).
      if (SKIP_LINK_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue;
      if (!found.includes(candidate)) found.push(candidate);
    }
  };

  // Pass 1 (raw html): plain regex + mailto: hrefs + Cloudflare's obfuscation,
  // over ALL pages first. The Cloudflare pass runs on the raw HTML because the
  // address only exists in an attribute — by the time the page is text, it
  // reads "[email protected]" and there is nothing left to find.
  for (const html of Object.values(pages)) {
    addAll(Array.from(html.matchAll(EMAIL_REGEX), (m) => m[0]));
    addAll(Array.from(html.matchAll(MAILTO_REGEX), (m) => (m[1] ?? "").split("?")[0].trim()));
    addAll(
      Array.from(html.matchAll(CF_EMAIL_REGEX), (m) => decodeCloudflareEmail(m[1])).filter(
        (email): email is string => email !== null
      )
    );
    // WordPress antispambot()-style cloaking (see deobfuscateEntityEncodedEmail).
    // Gated on "&#" so the decode+re-scan only runs on pages that actually
    // carry numeric entities, not every page (which nearly all do, via
    // &amp;/&nbsp;, but essentially none of which cloak an email this way).
    if (html.includes("&#")) {
      const deobfuscatedHtml = deobfuscateEntityEncodedEmail(html);
      addAll(Array.from(deobfuscatedHtml.matchAll(EMAIL_REGEX), (m) => m[0]));
      addAll(
        Array.from(deobfuscatedHtml.matchAll(MAILTO_REGEX), (m) => (m[1] ?? "").split("?")[0].trim())
      );
    }
  }

  // Pass 2 (cheerio-parsed): JSON-LD + de-obfuscated visible text, over ALL pages.
  for (const html of Object.values(pages)) {
    addAll(loadJsonLdEmails(html));

    const $ = cheerio.load(html);
    const text = getText($, { strip: false });
    const deobfuscated = Array.from(text.matchAll(OBFUSCATED_EMAIL_REGEX), (m) => deobfuscate(m[0]));
    addAll(deobfuscated.filter((email) => EMAIL_FULLMATCH_REGEX.test(email)));
  }

  return found.slice(0, MAX_CANDIDATES);
}

export function findEmailsInJson(obj: unknown): string[] {
  const results: string[] = [];
  if (Array.isArray(obj)) {
    for (const item of obj) {
      results.push(...findEmailsInJson(item));
    }
  } else if (obj !== null && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (key.toLowerCase() === "email" && typeof value === "string") {
        results.push(value.replaceAll("mailto:", "").trim());
      } else {
        results.push(...findEmailsInJson(value));
      }
    }
  }
  return results;
}

export function extractCandidatePhones(pages: Record<string, string>): string[] {
  const found: string[] = [];

  const addAll = (candidates: Iterable<string>): void => {
    for (const candidate of candidates) {
      const cleaned = candidate.trim();
      const digitCount = (cleaned.match(/\d/g) ?? []).length;
      if (digitCount >= PHONE_MIN_DIGITS && digitCount <= PHONE_MAX_DIGITS && !found.includes(cleaned)) {
        found.push(cleaned);
      }
    }
  };

  // Priority order, each pass fully completing (over all pages) before the next.
  for (const html of Object.values(pages)) {
    addAll(Array.from(html.matchAll(TEL_HREF_REGEX), (m) => (m[1] ?? "").split("?")[0].trim()));
  }

  for (const html of Object.values(pages)) {
    addAll(loadJsonLdPhones(html));
  }

  for (const html of Object.values(pages)) {
    addAll(Array.from(html.matchAll(WHATSAPP_PHONE_REGEX), (m) => m[1] ?? ""));
  }

  for (const html of Object.values(pages)) {
    addAll(Array.from(html.matchAll(PHONE_REGEX), (m) => m[1] ?? m[0]));
  }

  return found.slice(0, MAX_CANDIDATES);
}

export function findPhonesInJson(obj: unknown): string[] {
  const results: string[] = [];
  if (Array.isArray(obj)) {
    for (const item of obj) {
      results.push(...findPhonesInJson(item));
    }
  } else if (obj !== null && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if ((lowerKey === "telephone" || lowerKey === "phone") && typeof value === "string") {
        results.push(value.replaceAll("tel:", "").trim());
      } else {
        results.push(...findPhonesInJson(value));
      }
    }
  }
  return results;
}

export function buildFocusedContext(
  pages: Record<string, string>,
  candidates: string[],
  window: number = CONTEXT_WINDOW,
  maxChars: number = CONTEXT_MAX_CHARS
): string {
  const texts: string[] = [];
  for (const html of Object.values(pages)) {
    const $ = cheerio.load(html);
    texts.push(getText($, { strip: true }));
  }
  const combinedText = texts.join(" ");

  const snippets: string[] = [];
  for (const candidate of candidates) {
    const idx = combinedText.indexOf(candidate);
    if (idx === -1) continue;
    const start = Math.max(0, idx - window);
    const end = Math.min(combinedText.length, idx + candidate.length + window);
    snippets.push(combinedText.slice(start, end));
  }

  const focused = snippets.length > 0 ? snippets.join(" … ") : combinedText.slice(0, maxChars);
  return focused.slice(0, maxChars);
}

export function extractTextForOwner(pages: Record<string, string>): string {
  const texts: string[] = [];
  for (const [url, html] of Object.entries(pages)) {
    let path: string;
    try {
      path = new URL(url).pathname.toLowerCase();
    } catch {
      path = "";
    }
    const matches =
      ABOUT_PATH_KEYWORDS.some((kw) => path.includes(kw)) ||
      CONTACT_PATH_KEYWORDS.some((kw) => path.includes(kw));
    if (matches) {
      const $ = cheerio.load(html);
      texts.push(getText($, { strip: true }).slice(0, OWNER_TEXT_PER_PAGE_CHARS));
    }
  }
  return texts.join("\n\n").slice(0, OWNER_TEXT_TOTAL_CHARS);
}
