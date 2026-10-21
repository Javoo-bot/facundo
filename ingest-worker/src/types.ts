// Shared types for the ingest worker. Field names mirror the Python pipeline
// and the Supabase `florists` schema so ports stay faithful.

// Type-only import — erased at compile time, so this doesn't create a
// runtime cycle even though enrich.ts imports other types from this file.
import type { RecordedUsage } from "./enrich";

/** A normalized florist as returned by the Apify scrape (apify.ts), before
 * enrichment. Mutated in place through the pipeline (distance added, etc.). */
export interface ScrapedFlorist {
  place_id: string;
  name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  rating: number | null;
  review_count: number | null;
  phone_maps: string | null;
  website_url: string | null;
  maps_online_order: boolean | null;
  // Google's own Maps category — the relevance filter's free rule reads this
  // (relevance.ts::categoryMatchesFlorist). Persisted since 2026-08-04 so an
  // already-stored florist can be re-judged without re-scraping its city;
  // before that it was discarded when the run ended, which is why non-florists
  // predating the filter are stuck in the directory.
  category_name: string | null;
  categories: string[] | null;
  // Added by the pipeline (step 4).
  distance_km_from_center?: number | null;
}

/** Output of enrich.ts::enrichFlorist. Same 9 keys the Python enrichment dict
 * sets. `content_language` is computed but NOT persisted (folded into notes). */
export interface EnrichmentResult {
  has_website: boolean;
  is_ecommerce: boolean | null;
  ecommerce_signals: Record<string, unknown> | null;
  email: string | null;
  phone_web: string | null;
  owner_name: string | null;
  shop_highlight: string | null;
  content_language: string | null;
  enrichment_notes: string;
  /** What Sherlock was shown: one entry per model call made for this florist.
   * Null when no model ran. */
  enrichment_ai_context: EnrichmentAiContext | null;
}

export interface EnrichmentAiContext {
  agent: "sherlock";
  rulesHash: string;
  calls: { name: string; model: string; prompt: string }[];
}

/** A florists-table row for upsert (on_conflict city_id,place_id). */
export interface FloristRow {
  city_id: string;
  place_id: string;
  name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  rating: number | null;
  review_count: number | null;
  distance_km_from_center: number | null;
  phone_maps: string | null;
  website_url: string | null;
  has_website: boolean;
  // Google's Maps category, persisted so the relevance filter can re-judge an
  // existing florist without a re-scrape (see ScrapedFlorist above).
  category_name: string | null;
  categories: string[] | null;
  is_ecommerce: boolean | null;
  ecommerce_signals: Record<string, unknown> | null;
  email: string | null;
  phone_web: string | null;
  owner_name: string | null;
  shop_highlight: string | null;
  enrichment_notes: string | null;
  enrichment_ai_context: EnrichmentAiContext | null;
  deleted_at: string | null;
  // NOTE: drafted_email is deliberately never set here (Phase 0 invariant:
  // re-ingest must not null an on-demand draft).
}

// --- Structured-output shapes (prompts.py Pydantic models) ---
export interface EcommerceClassification {
  is_ecommerce: boolean;
  confidence: number;
  reasoning: string;
}
export interface EmailExtraction {
  email: string | null;
  confidence: number;
}
export interface PhoneExtraction {
  phone: string | null;
  confidence: number;
}
export interface OwnerInfo {
  owner_name: string | null;
  shop_highlight: string | null;
  content_language: string | null;
}
export interface KeywordSuggestion {
  keywords: string[];
  language: string;
}
export interface RelevanceClassification {
  is_florist: boolean;
  confidence: number;
  reasoning: string;
}

/** What an ingest_jobs row asks the pipeline to do.
 *
 * 'city'   — the full 8-step ingest (geocode → keywords → Apify → relevance →
 *            bare rows → enrich).
 * 'repair' — re-enrich florists ALREADY in the table for this city, with no
 *            Apify run. Exists because the crawl and the extraction can fail
 *            independently: on 2026-08-06 the pages were fetched fine and every
 *            LLM leg returned "credit balance is too low", leaving 1,732 live
 *            florists with a website, no email, and the error in their notes.
 *            See src/repair.ts and the design spec. */
export type IngestJobMode = "city" | "repair";

/** Queue message: one city to ingest, or one city's rows to repair. */
export interface CityJobMessage {
  jobId: string;
  country: string;
  city: string;
  radiusKm: number;
  limit: number;
  resetExisting: boolean;
  /** Optional on the wire: a message enqueued before the mode column existed
   * (or by anything that doesn't set it) is a normal city ingest. */
  mode?: IngestJobMode;
  /** Administrative region/state hint (e.g. "Balears") to disambiguate
   * same-named cities in the Nominatim query. */
  region?: string | null;
  /** Reference latitude the geocoded city center is sanity-checked against. */
  nearLat?: number | null;
  /** Reference longitude paired with nearLat. */
  nearLng?: number | null;
}

/** A `florists` row as the repair path reads it: enough to rebuild the
 * ScrapedFlorist that enrichFlorist takes, plus every column buildRepairPatch
 * has to check before it may write. */
export interface RepairTarget {
  id: string;
  place_id: string;
  name: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  rating: number | null;
  review_count: number | null;
  phone_maps: string | null;
  website_url: string | null;
  category_name: string | null;
  categories: string[] | null;
  distance_km_from_center: number | null;
  email: string | null;
  phone_web: string | null;
  owner_name: string | null;
  shop_highlight: string | null;
  is_ecommerce: boolean | null;
  /** Flat scalars only — that's what detectEcommerceSignals writes (platform,
   * cart_signal, product_schema, llm_confidence, …), and stating it rather than
   * `unknown` is what lets a RepairTarget cross a Workflow step boundary, where
   * results must be structured-cloneable. Repair only ever reads this for
   * null-ness anyway; the value it may write comes from a fresh
   * EnrichmentResult. */
  ecommerce_signals: Record<string, string | number | boolean | null> | null;
  enrichment_notes: string | null;
  /** Set when this shop's website sits on a known network/franchise/directory
   * domain — an independent reason to distrust the address, checked by
   * emailSkipReason ahead of the shared-count. */
  network_id: string | null;
  deleted_at: string | null;
  excluded_at: string | null;
}

/** The subset of `florists` columns a repair is allowed to write. Every key is
 * optional except the notes — see repair.ts::buildRepairPatch for why each of
 * the others may be absent, and which columns are absent by design. */
export interface RepairPatch {
  enrichment_notes: string | null;
  /** Like the notes, describes the most recent attempt. */
  enrichment_ai_context: EnrichmentAiContext | null;
  email?: string;
  phone_web?: string;
  owner_name?: string;
  shop_highlight?: string;
  is_ecommerce?: boolean;
  ecommerce_signals?: Record<string, unknown>;
  network_id?: string;
}

/** Queue message: one Shopify order to intake (from POST /webhooks/shopify). */
export interface OrderQueueMessage {
  shopifyOrderId: string;
  raw: unknown;
}

/** Cloudflare Worker environment bindings. */
export interface Env {
  // Queue producer binding (also the consumer, same worker).
  INGEST_QUEUE: Queue<CityJobMessage>;
  // Orders queue producer binding (webhook enqueues; same worker consumes).
  ORDER_QUEUE: Queue<OrderQueueMessage>;
  // Workflow binding.
  CITY_WORKFLOW: Workflow;
  // Order-intake Workflow binding.
  ORDER_WORKFLOW: Workflow;
  // Enrichment-batch Workflow binding — CityIngestWorkflow's child, one
  // instance per ENRICH_BATCH_SIZE-sized chunk of florists (see
  // config.ts::ENRICH_BATCH_SIZE and workflow.ts::runEnrichBatches).
  ENRICH_BATCH_WORKFLOW: Workflow;
  // Durable Object namespace for the Browser Rendering warm pool.
  BROWSER_POOL: DurableObjectNamespace;
  // Browser Rendering binding (Fetcher). Present only when provisioned.
  BROWSER?: Fetcher;
  // Secrets / vars.
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  OPENROUTER_API_KEY: string;
  // Langfuse traces of every model call (openrouter.ts::chat). Set on the
  // garden worker only; unset means no traces, which is how production stays out.
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_BASE_URL?: string;
  APIFY_TOKEN: string;
  ENABLE_BROWSER_RENDER?: string; // "true" to enable render fallback
  DEV_TRIGGER?: string; // "true" to allow the dev-only POST /__run trigger
  SHOPIFY_WEBHOOK_SECRET: string; // Shopify webhook signing secret (HMAC verify)
  // Shopify Admin API creds for the missing-webhook reconciliation sweep
  // (reconcile.ts). Same creds dashboard/lib/shopifyWriteback.ts uses. Optional:
  // when either is unset the sweep is a no-op (guarded), so the worker still
  // deploys/runs without them.
  SHOPIFY_SHOP?: string; // shop domain, e.g. "your-store.myshopify.com"
  SHOPIFY_ADMIN_TOKEN?: string; // Admin API access token (X-Shopify-Access-Token)
  // Shared secret for cross-service calls with the dashboard (already used the
  // other way, worker → dashboard, in scheduled()). Also gates the inbound
  // POST /reconcile on-demand trigger. Optional: when unset that route 501s.
  OUTBOX_SECRET?: string;
  // PostHog project token for order-automation events (analytics.ts). Optional:
  // unset means every capture call in analytics.ts no-ops, which is the normal
  // case in local dev/tests — nothing here needs a live PostHog project to pass
  // typecheck/tests. Server-side only (no NEXT_PUBLIC_ prefix): this worker never
  // ships posthog-js, it POSTs to PostHog's HTTP capture endpoint directly.
  POSTHOG_PROJECT_TOKEN?: string;
  POSTHOG_HOST?: string; // defaults to https://eu.i.posthog.com — see analytics.ts
  // `environment` property on every event. Set to "garden" only in env.garden.vars
  // (the garden shares production's PostHog project); unset reads as "production".
  POSTHOG_ENVIRONMENT?: string;
  // Daily automation digest (dailyDigest.ts). All optional: with RESEND_API_KEY
  // or DIGEST_TO unset the digest is a guarded no-op, so the worker deploys and
  // runs exactly as before without them.
  RESEND_API_KEY?: string; // same Resend key the dashboard sends with
  DIGEST_TO?: string; // comma-separated recipients
  DIGEST_FROM?: string; // defaults to a verified fc.example.net sender
  DIGEST_FORCE?: string; // "true" bypasses the 08:00-local gate (manual/QA runs)
  // Garden only (gardenActors.ts): pretend florists and clients reply to garden
  // emails. All four live in env.garden alone; production has none of them.
  GARDEN_ACTORS?: string; // "1" in env.garden.vars
  AI?: Ai; // Workers AI binding, declared under env.garden only
  GARDEN_INBOUND_WEBHOOK_SECRET?: string; // secret on the garden worker only
  DASHBOARD_URL?: string;
}

/** Workflow params (what CITY_WORKFLOW.create receives). */
export type CityWorkflowParams = CityJobMessage;

/** Params for one ENRICH_BATCH_WORKFLOW child instance — see
 * workflow.ts::runEnrichBatches. Exactly one of `florists`/`targets` is set,
 * matching `mode`; a union type isn't used because Workflow params must
 * round-trip through JSON as a single serializable shape. */
export interface EnrichBatchParams {
  jobId: string;
  cityId: string;
  phoneRegion: string | null;
  mode: "ingest" | "repair";
  /** mode: "ingest" */
  florists?: ScrapedFlorist[];
  /** mode: "repair" */
  targets?: RepairTarget[];
  /** mode: "repair" — domain -> network id, as entries (Map isn't
   * serializable). See db.ts::loadNetworkRegistry. */
  networkRegistryEntries?: [string, string][];
}

/** What one ENRICH_BATCH_WORKFLOW instance reports back via its `run()`
 * return value (readable from the parent as `status().output`). */
export interface EnrichBatchOutput {
  usages: RecordedUsage[];
  llmOutageHit: boolean;
  llmOutageDetail: string;
  count: number;
  /** mode: "repair" only. */
  emailsFound?: number;
  /** mode: "repair" only — targets whose row changed under us since the
   * parent's select and were left alone rather than patched against a stale
   * read. */
  skipped?: number;
}
