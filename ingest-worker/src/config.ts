// All ingest constants, ported verbatim from the Python pipeline
// (ingest/enrich.py, ingest/usage.py, ingest/geocode.py, ingest/scrape.py).
// This is the single source of truth for tunables — keep values in sync with
// the Python reference until ingest/ is decommissioned.

export const USER_AGENT =
  "facundo-poc-ingest/0.1 (+https://fc.example.com; contact: staff@fc.example.com)";

// Nominatim usage policy: <=1 request/sec + descriptive UA.
export const NOMINATIM_MIN_REQUEST_INTERVAL_MS = 1000;

// Fetch / render budgets. Raised from 5000 on 2026-09-03: a real florist
// (rosesboxrd.com — Shopify + a www->apex redirect hop on top of the usual
// http->https one) was blowing through 5s on BOTH the static fetch and the
// headless render, getting marked unreachable even though the page loads in
// well under a second once you're actually through the redirect chain — the
// email sat in plain text on /pages/contactanos with zero obfuscation.
// Workers CPU time (the thing metered/capped) excludes fetch I/O wait, so
// this costs nothing against the Paid-plan cpu_ms budget in wrangler.jsonc.
export const FETCH_TIMEOUT_MS = 15000;
export const RENDER_TIMEOUT_MS = 15000;
export const RENDER_SETTLE_MS = 500;
// Enrichment concurrency. NOTE (tested 2026-07-09): on the Workers FREE plan a
// full-city enrichment exceeds the per-invocation CPU cap regardless of this
// value — serial (1) and concurrent both hit "Worker exceeded CPU time limit",
// because the Workflow's step callbacks accumulate CPU within an invocation and
// the Free plan won't allow raising `limits.cpu_ms`. Resolving this needs EITHER
// the Workers PAID plan (then set `limits.cpu_ms: 300000` and raise this to ~10
// for throughput) OR a per-florist fan-out to a queue (one florist per
// invocation) — see DEPLOY.md "CPU limit on the Free plan". (Python used 10.)
export const MAX_CONCURRENT_ENRICHMENTS = 1;
export const MAX_CONCURRENT_RENDERS = 4;
export const MAX_PAGES_PER_FLORIST = 8;

// Added 2026-09-04, alongside ENRICH_BATCH_SIZE below: per-florist progress
// logging pinned the Kfar Saba OOM to a specific site (flowstore.co.il, a
// Wix page-builder site) whose homepage alone is 1.15MB of HTML — and
// crawlSite fetches up to MAX_PAGES_PER_FLORIST of those per florist, each
// re-parsed by Cheerio (whose DOM tree costs several times the raw HTML
// size). Batch size never mattered because the cost is concentrated in ONE
// heavy site's pages, not spread evenly across many florists. Contact info
// (email/phone/address) overwhelmingly lives in the head/nav/hero/footer —
// well within this cap — not deep in a page-builder's megabytes of embedded
// JS/JSON state, so capping is a quality tradeoff we're comfortable making.
// KEEP IN STEP with ingest/enrich.py::MAX_PAGE_BYTES.
export const MAX_PAGE_BYTES = 1_500_000;

// Added 2026-09-03: a real run (Kfar Saba, IL — 352 florists) died with
// "Worker exceeded memory limit" partway through enrichment. A Workflow
// instance keeps every completed step's result resident for the life of one
// continuous execution (that's how replay/durability works), so a long run of
// sequential `step.do()` enrichment calls accumulates memory without bound.
// Enrichment is chunked into batches of this size, each dispatched as its own
// child EnrichBatchWorkflow instance (see workflow.ts::runEnrichBatches) — a
// fresh isolate per batch bounds peak memory regardless of total city size.
//
// Lowered from 40 to 15 on 2026-09-04: a 94-florist repair run in ONE
// continuous instance had succeeded, so 40 looked comfortably safe — but a
// real 40-florist BATCH (Kfar Saba again, batch 2/6, a fresh isolate with no
// scrape/geocode overhead ahead of it) still OOM'd. Per-florist memory cost
// isn't uniform — how many of a site's crawled pages need headless
// rendering varies a lot — so no fixed count is a hard guarantee, only a
// probabilistic safety margin. 15 is a genuine guess at "comfortably below
// whatever the real ceiling is," not a value with its own confirmed-safe
// data point the way the old 40 briefly seemed to have. If batches keep
// OOMing at this size, the batch COUNT isn't the lever anymore — that would
// point at something batch-level (MAX_PAGES_PER_FLORIST, headless render
// memory) instead.
export const ENRICH_BATCH_SIZE = 15;

// Thin/JS-shell page thresholds.
export const THIN_HTML_BYTES = 2000; // raw HTML length (UTF-16 code units, matches Python len(str))
export const THIN_TEXT_CHARS = 200; // visible-text length

export const SKIP_LINK_SCHEMES = ["mailto:", "tel:", "javascript:", "#"] as const;
export const SKIP_LINK_EXTENSIONS = [
  ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".ico",
  ".css", ".js", ".zip", ".mp4", ".woff", ".woff2",
] as const;

// Link crawl priority scoring (max weight among substring matches wins).
// Which links are worth one of the crawl's few page slots. Retuned 2026-08-11
// after chaine-fleurs.com: the budget went to /panier (cart), /mon-compte and four
// product-collection pages, while /content/18-service-client — which holds the
// shop's address — scored ZERO and was never fetched. Two things were wrong.
//
// 1. The vocabulary was Spanish/Catalan/German/English. French, Italian and
//    Portuguese contact wording was absent, so "service-client",
//    "nous-connaitre" and "contatti" all scored nothing.
// 2. Cart, checkout and shop outranked `about`. They are here for the ecommerce
//    classifier, not for contact discovery, and they were beating the pages
//    that actually carry an address.
//
// The legal-notice page is now near the top, which looks odd until you know
// that mentions légales / aviso legal / note legali / Impressum are legally
// REQUIRED to publish a contact address in their jurisdictions. On the sample
// below they were the single richest source we were ignoring.
export const LINK_PRIORITY_KEYWORDS: Record<string, number> = {
  // Straight-up contact pages.
  contact: 10, contacto: 10, contacte: 10, contatti: 10, contato: 10, kontakt: 10,
  contactez: 10, "nous-contacter": 10, "service-client": 10, serviceclient: 10,
  "customer-service": 10, atencion: 10, "atencion-al-cliente": 10,
  // Publisher/legal pages: an address is mandatory on these across the EU.
  impressum: 9, "mentions-legales": 9, mentionslegales: 9, "aviso-legal": 9,
  "note-legali": 9, "legal-notice": 9, "informacion-legal": 9,
  // Who-we-are pages: often an address, usually the owner's name.
  about: 8, sobre: 8, nosotros: 8, "quienes-somos": 8, "qui-sommes-nous": 8,
  "nous-connaitre": 8, "chi-siamo": 8, "sobre-nos": 8, "a-propos": 8,
  // Kept above the shallow-path bonus so the ecommerce classifier still sees a
  // shop page on most sites, but no longer ahead of the pages with an address.
  cart: 7, carrito: 7, cesta: 7, cistella: 7, checkout: 7, panier: 7,
  tienda: 7, botiga: 7, shop: 7, store: 7, comprar: 7,
  producto: 6, productos: 6, catalogo: 6, catalogue: 6, boutique: 6,
  team: 6,
  location: 6, locations: 6, ubicacion: 6, ubicaciones: 6,
  tiendas: 6, sucursal: 6, sucursales: 6, "store-locator": 6,
  // Last resort, above the shallow bonus only: a privacy policy names the data
  // controller, which on a one-shop site is the shop. Noisy (it also yields
  // agency and DPO addresses), so it is the lowest thing we will spend a slot on.
  privacy: 4, "politique-de-confidentialite": 4, privacidad: 4, datenschutz: 4,
};
export const SHALLOW_PATH_BONUS = 3;

export const SOCIAL_HOSTNAMES = [
  "instagram.com", "facebook.com", "fb.me", "m.facebook.com",
  "tiktok.com", "x.com", "twitter.com", "threads.com", "threads.net",
  "linktr.ee", "linktree.com", "beacons.ai", "taplink.cc", "taplink.at",
  "campsite.bio", "bio.link", "lnk.bio", "solo.to", "milkshake.app", "carrd.co",
] as const;
export const REDIRECT_WRAPPER_HOSTNAMES = ["l.instagram.com", "l.facebook.com", "lm.facebook.com"] as const;
export const NON_BIO_LINK_HOSTNAMES = [
  "meta.com", "about.meta.com", "meta.ai", "help.instagram.com", "help.facebook.com",
  "privacycenter.instagram.com", "developers.facebook.com",
  "business.instagram.com", "business.facebook.com",
  "apps.apple.com", "play.google.com", "itunes.apple.com",
] as const;
export const LOGIN_WALL_MARKERS = [
  "log in to instagram", "you must log in", "login • instagram",
  "see posts, photos and more on facebook", "you'll need to log in",
  "sorry, this page isn't available",
] as const;

// Ecommerce rule signals.
export const ECOMMERCE_PLATFORM_SIGNALS = [
  "shopify", "woocommerce", "magento", "bigcommerce", "prestashop",
  "squarespace-commerce", "sqs-commerce", "wix-stores", "wixstores", "ecwid",
] as const;
export const ECOMMERCE_CART_SIGNALS = [
  "/cart", "/checkout", "add-to-cart", "addtocart", "add to cart",
  "carrito", "cesta", "cistella", "/comprar", "finalizar compra", "finalizar-compra",
  "add to basket", "afegir a la cistella", "añadir al carrito",
] as const;
export const ECOMMERCE_SHOP_PATH_SIGNALS = ["/tienda", "/botiga", "/shop", "/store", "/producto", "/productos"] as const;
export const ECOMMERCE_NETWORK_MARKERS: [string, string][] = [
  ["interflora", "interflora"],
  ["livingwithflowerseveryday", "interflora"],
  ["teleflora", "teleflora"],
];
export const STRONG_ECOMMERCE_SIGNAL_KEYS = [
  "platform", "cart_signal", "product_schema", "network_marker", "maps_online_order",
] as const;

// Email / phone extraction regexes (global + case-insensitive where the Python used re.IGNORECASE).
// Local part adds Latin-1 Supplement + Latin Extended-A letters (À-ÖØ-öø-ÿĀ-ž) to
// a-zA-Z0-9 so genuine es/fr/it/de addresses with accented local parts (e.g.
// "concepciónperez@correo-demo.es") aren't silently truncated. Deliberately
// NOT \p{L} (any Unicode letter) — that also swallows adjacent CJK/Cyrillic/etc.
// text glued in front of a real ASCII email with no separator, trading one silent
// corruption for another. This POC's markets are Latin-script only.
export const EMAIL_REGEX = /[a-zA-Z0-9À-ÖØ-öø-ÿĀ-ž._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
export const EMAIL_FULLMATCH_REGEX = /^[a-zA-Z0-9À-ÖØ-öø-ÿĀ-ž._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
export const MAILTO_REGEX = /mailto:([^"'\s?>]+)/gi;
export const OBFUSCATED_EMAIL_REGEX =
  /[a-zA-Z0-9À-ÖØ-öø-ÿĀ-ž._%+\-]+\s*(?:\(at\)|\[at\]|\bat\b)\s*[a-zA-Z0-9.\-]+\s*(?:\(dot\)|\[dot\]|\bdot\b)\s*[a-zA-Z]{2,}/gi;
export const DEOBFUSCATE_PATTERNS: [RegExp, string][] = [
  [/\(at\)|\[at\]|\bat\b/gi, "@"],
  [/\(dot\)|\[dot\]|\bdot\b/gi, "."],
];
// Cloudflare's email obfuscation. It rewrites an address to
// <a href="/cdn-cgi/l/email-protection#<hex>" data-cfemail="<hex>">[email&nbsp;protected]</a>
// and decodes it in the browser. The hex is XOR'd against its own first byte —
// no JS needed to reverse it, which matters because our crawler doesn't run
// theirs. Without this the page reads "[email protected]" and yields nothing.
export const CF_EMAIL_REGEX = /(?:data-cfemail="|\/cdn-cgi\/l\/email-protection#)([0-9a-fA-F]{4,})/g;

export const TEL_HREF_REGEX = /tel:([^"'\s?>]+)/gi;
export const WHATSAPP_PHONE_REGEX =
  /(?:wa\.me\/|whatsapp\.com\/send\?(?:[^"'>\s]*&)?phone=)([0-9][0-9()+\-.\s]{6,20}[0-9])/gi;
export const PHONE_REGEX = /(\+?\(?\d[\d\-.\s()]{6,}\d\)?)/g;

export const SKIP_EMAIL_DOMAIN_SUFFIXES = ["wixsite.com", "sentry.io", "example.com", "godaddy.com"] as const;
export const SKIP_EMAIL_LOCAL_PREFIXES = ["noreply", "no-reply", "donotreply", "do-not-reply"] as const;

export const ABOUT_PATH_KEYWORDS = ["about", "sobre", "nosotros", "quienes-somos", "team", "impressum", "über-uns", "uber-uns"] as const;
// Used to decide which crawled page gets fed to the owner-name extractor. Same
// blind spot as LINK_PRIORITY_KEYWORDS had: 122 of 1000 emailless florists
// carried the note "No contact/about-style page content found", many of them
// French sites whose contact page is /service-client or /nous-connaitre.
export const CONTACT_PATH_KEYWORDS = [
  "contact", "contacto", "contacte", "contatti", "contato", "kontakt",
  "service-client", "serviceclient", "nous-contacter", "customer-service",
  "impressum", "mentions-legales", "aviso-legal", "note-legali", "legal-notice",
  "about", "nosotros", "quienes-somos", "qui-sommes-nous", "nous-connaitre",
  "chi-siamo", "sobre-nos", "a-propos",
] as const;

export const MAX_CANDIDATES = 10;
export const PHONE_MIN_DIGITS = 8;
export const PHONE_MAX_DIGITS = 15;

// Focused-context builder.
export const CONTEXT_WINDOW = 180;
export const CONTEXT_MAX_CHARS = 1600;
export const OWNER_TEXT_PER_PAGE_CHARS = 4000;
export const OWNER_TEXT_TOTAL_CHARS = 8000;
export const ECOMMERCE_HTML_EXCERPT_CHARS = 6000;

// --- LLM cost tracking + per-call-type model routing (ingest/usage.py) ---
export type CallType = "ecommerce" | "email" | "phone" | "owner" | "draft" | "relevance";
export const CALL_TYPES: CallType[] = ["ecommerce", "email", "phone", "owner", "draft", "relevance"];

// (input_per_mtok, output_per_mtok) USD per 1,000,000 tokens.
// Fallback rates only — OpenRouter reports the actual charged cost on every
// response and usage.ts prefers that (see its header). Kept so a response that
// omits usage accounting still costs something rather than silently $0.
// Verified against OpenRouter's live /models on 2026-08-07; these match
// Anthropic's own list price.
export const PRICING: Record<string, [number, number]> = {
  "anthropic/claude-sonnet-5": [2.0, 10.0],
  "anthropic/claude-haiku-4.5": [1.0, 5.0],
};

// relevance (is-this-actually-a-florist judgment) stays on Sonnet-5 alongside
// ecommerce/owner — a business-type judgment call, not mechanical extraction,
// and a relevance drop is permanent (see relevance.ts), so accuracy is
// favored over the small cost delta vs Haiku.
export const MODEL_FOR_CALL: Record<CallType, string> = {
  ecommerce: "anthropic/claude-sonnet-5",
  owner: "anthropic/claude-sonnet-5",
  draft: "anthropic/claude-sonnet-5",
  relevance: "anthropic/claude-sonnet-5",
  phone: "anthropic/claude-haiku-4.5",
  email: "anthropic/claude-haiku-4.5",
};

// Apify actor.
export const APIFY_ACTOR_ID = "compass~crawler-google-places";
export const ONLINE_ORDER_LABEL_KEYWORDS = [
  "online order", "order online", "online ordering",
  "online estimate", "online appointment", "online booking",
] as const;

// Job progress log tail.
export const JOB_LOG_MAX_LINES = 50;

// Cron-claim sweep: max queued jobs claimed per tick (backpressure).
export const MAX_JOBS_PER_SWEEP = 20;

/**
 * How many ingest jobs may be RUNNING at once, across the whole account.
 *
 * This is not a "make it parallel" knob — the pipeline was already parallel,
 * and unboundedly so. The queue consumer calls `CITY_WORKFLOW.create()` and
 * acks immediately (index.ts), so it never waits for a city to finish; the
 * consumer's `max_concurrency: 5` throttles DISPATCH, which takes milliseconds,
 * not execution. With only MAX_JOBS_PER_SWEEP for backpressure, a 41-city batch
 * claimed 20 jobs a minute and had every one of them running inside three
 * minutes, against a pipeline where a city takes ~5-6 minutes.
 *
 * That overruns Apify. Measured on the account 2026-09-10:
 *
 *   maxConcurrentActorJobs   32
 *   maxActorMemoryGbytes     64      <- the binding constraint
 *   actor default memory      4 GB   (compass~crawler-google-places)
 *
 * 64 / 4 = 16 simultaneous runs, and the 17th does not queue. Apify's docs are
 * explicit: "The sum of memory allocated for all running Actors and builds
 * needs to be within this limit, otherwise the user cannot start a new Actor."
 * `startApifyRun` throws, the `scrape-start` step burns its retries against a
 * ceiling that only clears when earlier cities finish, and cities fail for a
 * reason that looks nothing like the cause.
 *
 * 8 is half the Apify ceiling, deliberately:
 *   - The order loop shares this Apify account (autoIngest.ts scrapes on a cold
 *     offer). A recruiting batch must not make a real order unplaceable, so the
 *     campaign never takes more than half the memory.
 *   - Geocoding is the other shared resource and it is far more fragile:
 *     Nominatim's policy is 1 req/sec and geocode.ts's throttle is module-scope
 *     state in one isolate, so N concurrent first-time cities burst N lookups
 *     regardless of it. Every city in a fresh campaign is a cache miss.
 *   - A wider bound buys little. Apify is ~27% of a city's wall clock (Soria:
 *     1m31s of 5m38s); the rest is enrichment. 41 cities at 8-way is ~30 min
 *     against ~4 hours serial, and 16-way would only take it to ~16 min.
 *
 * Raise it by fixing the constraints, not by raising the number: pin an
 * explicit `memory=2048` on the Apify run (halving the reservation doubles the
 * ceiling to 32, and costs nothing — this actor bills per RESULT, not per
 * compute unit, which is why monthlyActorComputeUnits reads 0) and give
 * geocoding a real cross-invocation rate limit.
 */
export const MAX_IN_FLIGHT_INGEST_JOBS = 8;

/**
 * How long a job may sit `running` before the cron treats it as dead.
 *
 * Nothing used to reap these. A job only leaves `running` when the process that
 * claimed it writes a terminal status, so a claimer that dies hard — machine
 * asleep, process killed, poller stopped mid-run — leaves the row `running`
 * forever. Two Sitges jobs sat that way for 29 days, wedged at "[6/7]
 * Enriching…".
 *
 * That is not just cosmetic: autoIngest.ts::queueIngestForArea treats a
 * `running` job for an area as "already in progress" and refuses to queue
 * another, so one wedged row permanently blocks its city from ever being
 * re-ingested — including by the order page's Scrape button.
 *
 * 6h is deliberately far above any real run (a 276-place city takes ~15 min),
 * so this only ever catches something genuinely dead. Reaping does not cancel a
 * live Workflow — if one somehow is still going it writes its own terminal
 * status afterwards and the row self-corrects.
 */
export const STALE_RUNNING_JOB_HOURS = 6;
