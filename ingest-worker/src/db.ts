// Supabase client factory + upsert helpers.
//
// Ingest always uses the service-role key (bypasses RLS) — writes are
// performed server-side by this Worker, never by the dashboard.
//
// Ported from ingest/db.py (get_client, soft_delete_city_florists,
// get_excluded_place_ids, get_or_create_city, get_city_center,
// upsert_florists) plus the row builders from ingest/main.py
// (_build_bare_row, _build_row).

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "./phones";
import { phoneRegionFor } from "./shopCountry";
import { repairNotesFilter, sharedEmailCounts, wantedSharedCount } from "./repair";
import type {
  EnrichmentResult,
  FloristRow,
  RepairPatch,
  RepairTarget,
  ScrapedFlorist,
} from "./types";
import type { Candidate, MatchFlorist, TestShopMatching, MatchConfig } from "./match";
import { boundingBox, MATCHABLE, MATCH_CONFIG_COLUMNS, parseMatchConfig } from "./match";
import type { OrderInsert, LineItemInsert } from "./shopify";
import { computePayoutPrice } from "./payoutMath";

export function createServiceClient(env: {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

/** Return {cityId, wasCreated}.
 *
 * `geocodeFn` (Nominatim) is always called for a brand-new city, since
 * center_lat/center_lng have to come from somewhere. For an *existing* city
 * it's normally skipped (`cities` acts as a cache) — except when the row has
 * no `region` yet, in which case it's called once more just to backfill that
 * field, so a plain re-run of ingest fills in a missing region without
 * re-geocoding cities that already have one.
 *
 * `radiusKm` is the radius used for *this* ingest run; it's persisted on the
 * city row (created or existing) so the dashboard can show/draw the search
 * area actually used most recently.
 *
 * `regionHint` (e.g. an order's own delivery_address.region) changes the
 * strategy entirely, to disambiguate same-named cities in different regions
 * (see supabase/migrations/2026-08-25-ingest-region-disambiguation.sql):
 * `geocodeFn` is always called fresh — Nominatim calls are free/rate-limited,
 * not metered like Apify, so re-geocoding every hinted call is a deliberate
 * correctness-over-caching trade for this path only — and the cache lookup is
 * keyed on (country, city, resolvedRegion), where resolvedRegion is what
 * Nominatim itself just returned (not the hint string verbatim — they may
 * differ in wording, e.g. hint "Balears" vs Nominatim's own "Illes Balears"),
 * so repeated hinted calls for the same real place converge onto the same
 * row instead of duplicate-inserting. */
export async function getOrCreateCity(
  sb: SupabaseClient,
  country: string,
  city: string,
  radiusKm: number,
  geocodeFn: () => Promise<{ lat: number; lng: number; region: string | null }>,
  regionHint?: string | null
): Promise<{ cityId: string; wasCreated: boolean }> {
  const hint = regionHint?.trim();

  if (hint) {
    const { lat, lng, region } = await geocodeFn();
    const resolvedRegion = region ?? "";
    const existing = await sb
      .from("cities")
      .select("id")
      .eq("country", country)
      .eq("city", city)
      .eq("region", resolvedRegion)
      .limit(1);
    if (existing.error) throw existing.error;

    if (existing.data && existing.data.length > 0) {
      const cityId = existing.data[0].id as string;
      const { error } = await sb.from("cities").update({ radius_km: radiusKm }).eq("id", cityId);
      if (error) throw error;
      return { cityId, wasCreated: false };
    }

    const inserted = await sb
      .from("cities")
      .insert({
        country,
        city,
        center_lat: lat,
        center_lng: lng,
        radius_km: radiusKm,
        region: resolvedRegion,
      })
      .select("id")
      .single();
    if (inserted.error) throw inserted.error;
    return { cityId: inserted.data.id as string, wasCreated: true };
  }

  const existing = await sb
    .from("cities")
    .select("id, region")
    .eq("country", country)
    .eq("city", city)
    .limit(1);
  if (existing.error) throw existing.error;

  if (existing.data && existing.data.length > 0) {
    const cityId = existing.data[0].id as string;
    const update: Record<string, unknown> = { radius_km: radiusKm };
    if (!existing.data[0].region) {
      const { region } = await geocodeFn();
      update.region = region ?? "";
    }
    const { error } = await sb.from("cities").update(update).eq("id", cityId);
    if (error) throw error;
    return { cityId, wasCreated: false };
  }

  const { lat, lng, region } = await geocodeFn();
  const inserted = await sb
    .from("cities")
    .insert({
      country,
      city,
      center_lat: lat,
      center_lng: lng,
      radius_km: radiusKm,
      region: region ?? "",
    })
    .select("id")
    .single();
  if (inserted.error) throw inserted.error;
  return { cityId: inserted.data.id as string, wasCreated: true };
}

export async function getCityCenter(sb: SupabaseClient, cityId: string): Promise<{ lat: number; lng: number }> {
  const { data, error } = await sb
    .from("cities")
    .select("center_lat, center_lng")
    .eq("id", cityId)
    .limit(1)
    .single();
  if (error) throw error;
  return { lat: data.center_lat as number, lng: data.center_lng as number };
}

/** Soft-delete every currently-active florist of `cityId` (set deleted_at =
 * now()). Returns the number of rows affected. Used by the delete-first
 * re-run reset; rows are hidden, not removed, and any that reappear in the
 * scrape are resurrected by the upsert (which sets deleted_at = null). */
export async function softDeleteCityFlorists(sb: SupabaseClient, cityId: string): Promise<number> {
  const { data, error } = await sb
    .from("florists")
    .update({ deleted_at: new Date().toISOString() })
    .eq("city_id", cityId)
    .is("deleted_at", null)
    .select("place_id");
  if (error) throw error;
  return (data || []).length;
}

/** place_ids of this city's permanently-excluded florists (excluded_at set).
 * The ingest drops these from the scrape so they're never (re-)persisted. */
export async function getExcludedPlaceIds(sb: SupabaseClient, cityId: string): Promise<Set<string>> {
  const { data, error } = await sb
    .from("florists")
    .select("place_id")
    .eq("city_id", cityId)
    .not("excluded_at", "is", null);
  if (error) throw error;
  return new Set((data || []).map((row) => row.place_id as string));
}

/** place_ids of this city's florists whose lifecycle_stage is past the default
 * discovery stages ('found'/'targeted') — a human has already acted on them
 * (contacted, engaged, onboarding, production) or explicitly marked them lost.
 * The relevance filter never re-judges these: a Claude false-negative on a
 * re-scrape must not silently soft-delete a florist already carrying real
 * outreach/order history. */
export async function getPlaceIdsWithAdvancedLifecycle(sb: SupabaseClient, cityId: string): Promise<Set<string>> {
  const { data, error } = await sb
    .from("florists")
    .select("place_id")
    .eq("city_id", cityId)
    .not("lifecycle_stage", "in", "(found,targeted)");
  if (error) throw error;
  return new Set((data || []).map((row) => row.place_id as string));
}

/** Upsert florist rows keyed on (city_id, place_id) — idempotent re-runs.
 * Accepts full rows or maps-only bare rows (upsert-on-conflict only writes the
 * columns present, so a bare row never nulls enrichment columns). */
export async function upsertFlorists(
  sb: SupabaseClient,
  rows: Array<FloristRow | BareFloristRow>
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await sb.from("florists").upsert(rows, { onConflict: "city_id,place_id" });
  if (error) throw error;
}

/** Default this city's florists' UI/email locale from their country (see
 * locale.ts::regionToLocale), filling only rows without a locale yet. Returns the
 * number updated. The `locale is null` guard means a florist's own language choice
 * always wins, so this is safe to re-run on every ingest. A no-op when the country
 * doesn't imply a supported non-English language (locale null) — those florists
 * stay null and resolve to EN. */
export async function fillNullLocales(sb: SupabaseClient, cityId: string, locale: string | null): Promise<number> {
  if (!locale) return 0;
  const { data, error } = await sb
    .from("florists")
    .update({ locale })
    .eq("city_id", cityId)
    .is("locale", null)
    .is("deleted_at", null)
    .select("id");
  if (error) throw error;
  return (data ?? []).length;
}

/** Maps-only row persisted right after scraping, so the city is queryable
 * before enrichment finishes. Enrichment columns are left null/default;
 * deleted_at=null resurrects a returning-after-reset florist. The full row
 * (`buildRow`) overwrites this as each florist finishes enriching. */
export type BareFloristRow = Pick<
  FloristRow,
  | "city_id"
  | "place_id"
  | "name"
  | "address"
  | "lat"
  | "lng"
  | "rating"
  | "review_count"
  | "distance_km_from_center"
  | "phone_maps"
  | "website_url"
  | "has_website"
  | "category_name"
  | "categories"
  | "deleted_at"
>;

export function buildBareRow(
  f: ScrapedFlorist,
  cityId: string,
  phoneRegion: string | null
): BareFloristRow {
  return {
    city_id: cityId,
    place_id: f.place_id,
    name: f.name,
    address: f.address ?? null,
    lat: f.lat ?? null,
    lng: f.lng ?? null,
    rating: f.rating ?? null,
    review_count: f.review_count ?? null,
    distance_km_from_center: f.distance_km_from_center ?? null,
    phone_maps: normalizePhone(f.phone_maps ?? null, phoneRegionFor(f.address, phoneRegion)),
    website_url: f.website_url ?? null,
    has_website: Boolean(f.website_url),
    // Google's own category — the relevance filter's free rule reads this.
    // Persisted so an existing florist can be re-judged without re-scraping.
    category_name: f.category_name ?? null,
    categories: f.categories ?? null,
    deleted_at: null,
  };
}

export function buildRow(
  f: ScrapedFlorist & Partial<EnrichmentResult>,
  cityId: string,
  phoneRegion: string | null
): FloristRow {
  return {
    city_id: cityId,
    place_id: f.place_id,
    name: f.name,
    address: f.address ?? null,
    lat: f.lat ?? null,
    lng: f.lng ?? null,
    rating: f.rating ?? null,
    review_count: f.review_count ?? null,
    distance_km_from_center: f.distance_km_from_center ?? null,
    phone_maps: normalizePhone(f.phone_maps ?? null, phoneRegionFor(f.address, phoneRegion)),
    website_url: f.website_url ?? null,
    has_website: f.has_website ?? false,
    // See buildBareRow — kept on the full row too, so a florist that finishes
    // enrichment doesn't lose the category the bare row already stored.
    category_name: f.category_name ?? null,
    categories: f.categories ?? null,
    is_ecommerce: f.is_ecommerce ?? null,
    ecommerce_signals: f.ecommerce_signals ?? null,
    email: f.email ?? null,
    phone_web: normalizePhone(f.phone_web ?? null, phoneRegionFor(f.address, phoneRegion)),
    owner_name: f.owner_name ?? null,
    shop_highlight: f.shop_highlight ?? null,
    enrichment_notes: f.enrichment_notes ?? null,
    enrichment_ai_context: f.enrichment_ai_context ?? null,
    // drafted_email is deliberately omitted: it's written on-demand from the
    // dashboard (POST /api/florists/draft-email). Upsert-on-conflict updates
    // only the keys present here, so re-ingesting a city preserves any
    // existing draft rather than nulling it.
    deleted_at: null,
  };
}

// --- enrichment repair ------------------------------------------------------
// The I/O half of repair mode; the decisions are in repair.ts. See
// docs/superpowers/specs/2026-08-11-enrichment-repair-mode-design.md.

/** Look up an EXISTING city by (country, city). Repair mode never creates one:
 * a typo'd city name must fail the job loudly rather than quietly enriching an
 * empty new row. Returns null when there's no such city. */
export async function findCityIdByName(
  sb: SupabaseClient,
  country: string,
  city: string
): Promise<string | null> {
  const { data, error } = await sb
    .from("cities")
    .select("id")
    .eq("country", country)
    .eq("city", city)
    .limit(1);
  if (error) throw error;
  return data && data.length > 0 ? (data[0].id as string) : null;
}

/** The `florist_networks` registry as {registrable domain → network id}.
 *
 * Read-only: unlike the Python original this does NOT seed rows, because the
 * table is already populated and the seed list lives in ingest/networks.py.
 * A repair only needs to LINK against what a human has already confirmed. */
export async function loadNetworkRegistry(sb: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await sb.from("florist_networks").select("id, domain");
  if (error) throw error;
  const registry = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ id: string; domain: string | null }>) {
    const domain = (row.domain ?? "").trim().toLowerCase();
    if (domain) registry.set(domain, row.id);
  }
  return registry;
}

const REPAIR_TARGET_COLUMNS =
  "id, place_id, name, address, lat, lng, rating, review_count, phone_maps, website_url, " +
  "category_name, categories, distance_km_from_center, email, phone_web, owner_name, " +
  "shop_highlight, is_ecommerce, ecommerce_signals, enrichment_notes, network_id, deleted_at, excluded_at";

/** Florists in `cityId` whose enrichment left them with no email AND recorded a
 * failure while getting there. Paged, because a big city can exceed PostgREST's
 * default page size and a silently truncated repair looks exactly like a
 * successful one. */
export async function selectRepairTargets(
  sb: SupabaseClient,
  cityId: string
): Promise<RepairTarget[]> {
  const rows: RepairTarget[] = [];
  const pageSize = 1000;
  for (let page = 0; ; page++) {
    const { data, error } = await sb
      .from("florists")
      .select(REPAIR_TARGET_COLUMNS)
      .eq("city_id", cityId)
      .not("website_url", "is", null)
      .is("email", null)
      .is("deleted_at", null)
      .is("excluded_at", null)
      .or(repairNotesFilter())
      .range(page * pageSize, page * pageSize + pageSize - 1);
    if (error) throw error;
    const batch = (data ?? []) as unknown as RepairTarget[];
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
}

/**
 * Apply one repair patch. Returns whether the row was actually written.
 *
 * A targeted update by id, NOT an upsert with buildRow — buildRow hardcodes
 * `deleted_at: null` and would resurrect a florist someone soft-deleted while
 * the run was in flight.
 *
 * When the patch carries an email the update is additionally guarded on
 * `email is null`, so a staff correction landing mid-run wins the race instead
 * of being clobbered by a crawl that started before it. That guard covers the
 * whole patch, which is the right trade: if the address changed under us, the
 * rest of this florist's fresh data is about a row we no longer have a current
 * read of, and the next run picks it up.
 */
export async function applyRepairPatch(
  sb: SupabaseClient,
  floristId: string,
  patch: RepairPatch
): Promise<boolean> {
  let q = sb.from("florists").update(patch).eq("id", floristId).is("deleted_at", null);
  if (patch.email != null) q = q.is("email", null);
  const { data, error } = await q.select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * Recompute `florists.email_shared_count` across ALL florists. Port of
 * ingest/db.py::sweep_shared_emails. Returns how many rows changed.
 *
 * Global rather than per-city on purpose: two shops sharing an address are very
 * often in DIFFERENT cities (a national network), so a city-scoped sweep would
 * score both as unique and miss exactly the case that matters.
 */
export async function sweepSharedEmails(sb: SupabaseClient): Promise<number> {
  const rows: Array<{ id: string; email: string | null; email_shared_count: number | null }> = [];
  const pageSize = 1000;
  for (let page = 0; ; page++) {
    const { data, error } = await sb
      .from("florists")
      .select("id, email, email_shared_count")
      .is("deleted_at", null)
      .range(page * pageSize, page * pageSize + pageSize - 1);
    if (error) throw error;
    const batch = (data ?? []) as Array<{
      id: string;
      email: string | null;
      email_shared_count: number | null;
    }>;
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }

  const counts = sharedEmailCounts(rows);
  let changed = 0;
  for (const row of rows) {
    const want = wantedSharedCount(row.email, counts);
    if (row.email_shared_count === want) continue;
    const { error } = await sb
      .from("florists")
      .update({ email_shared_count: want })
      .eq("id", row.id);
    if (error) throw error;
    changed++;
  }
  return changed;
}

export async function findCityIdForOrder(sb: SupabaseClient, order: OrderInsert): Promise<string | null> {
  const addr = (order.delivery_address ?? {}) as Record<string, unknown>;
  const city = addr.city as string | undefined;
  const country = addr.country as string | undefined; // country_code, e.g. "ES"
  if (!city) return null;
  let q = sb.from("cities").select("id").ilike("city", city);
  if (country) q = q.eq("country", country);
  const { data } = await q.limit(1);
  return (data?.[0]?.id as string | undefined) ?? null;
}

export async function upsertOrder(sb: SupabaseClient, order: OrderInsert & { city_id: string | null }): Promise<string> {
  const { data, error } = await sb.from("orders").upsert(order, { onConflict: "shopify_order_id" }).select("id").single();
  if (error) throw error;
  return data.id as string;
}

// Columns that never come from the REST order payload — they're backfilled by the
// follow-up GraphQL variant lookup (shopifyImages.ts::fetchVariantDetails), which
// only the intake path (orderWorkflow.ts) runs. parseShopifyOrder hard-codes them
// null, so any caller re-parsing a webhook payload arrives here with nulls.
const ENRICHED_COLUMNS = [
  "image_url", "barcode", "bouquet_spec", "variant_text", "variant_icon_url", "components", "addons",
] as const;

/** Stable identity for matching a re-parsed line item back to its stored row.
 * sku is the real key here (Shopify sends it on every line item, e.g.
 * "FC2328-large"); title+variant is the fallback for the odd item without one. */
const lineItemKey = (i: { sku: string | null; title: string | null; variant: string | null }): string =>
  i.sku ? `sku:${i.sku}` : `tv:${i.title ?? ""}|${i.variant ?? ""}`;

/** Every column this module writes to order_line_items — the comparison basis for
 * the unchanged-check below. */
const LINE_ITEM_COLUMNS = [
  "title", "variant", "sku", "catalog_id", "variant_id", "quantity", "unit_price", "line_total",
  "product_type", "personalization", ...ENRICHED_COLUMNS,
] as const;

/** Order-independent signature of a line-item set, used to decide whether a
 * rewrite would be a no-op. Rows are sorted so Postgres' arbitrary return order
 * can't make an identical set look changed; numerics are coerced because
 * PostgREST can hand a `numeric` column back as a string. */
function lineItemsSignature(rows: Array<Record<string, unknown>>): string {
  const norm = rows.map((r) => LINE_ITEM_COLUMNS.map((c) => {
    const v = r[c];
    if (v == null) return null;
    return typeof v === "number" || !isNaN(Number(v)) && v !== "" ? Number(v) : v;
  }));
  return JSON.stringify(norm.map((r) => JSON.stringify(r)).sort());
}

export async function replaceLineItems(sb: SupabaseClient, orderId: string, items: LineItemInsert[]): Promise<void> {
  // Carry forward the GraphQL-backfilled columns before the delete. Without this,
  // every refreshFromShopify (i.e. EVERY orders/updated webhook — which fires on
  // any mutation — plus the reconcile sweeps) overwrites a correctly-enriched row
  // with nulls, permanently losing the line-item photo the florist works from.
  // Only ever FILLS a null: a caller that did run the lookup (intake) still wins.
  const { data: stored } = await sb
    .from("order_line_items")
    .select("*")
    .eq("order_id", orderId);
  const storedRows = (stored ?? []) as unknown as Array<Record<string, unknown>>;
  const preserved = new Map<string, Record<string, unknown>>();
  for (const row of storedRows) {
    // First row wins for a duplicated key — the values we copy are per-variant,
    // so two lines sharing a sku carry the same enrichment anyway.
    const k = lineItemKey(row as { sku: string | null; title: string | null; variant: string | null });
    if (!preserved.has(k)) preserved.set(k, row);
  }

  const merged = items.map((i) => {
    const prev = preserved.get(lineItemKey(i));
    if (!prev) return { ...i, order_id: orderId } as Record<string, unknown>;
    const filled: Record<string, unknown> = { ...i, order_id: orderId };
    for (const col of ENRICHED_COLUMNS) {
      if (filled[col] == null && prev[col] != null) filled[col] = prev[col];
    }
    return filled;
  });

  // Nothing actually changed → don't churn the rows. orders/updated fires on ANY
  // mutation (measured: ~14 per order, tagging/fulfilment/payment), and every one
  // of them used to delete and re-insert this order's line items, cycling their
  // primary keys. Skipping the no-op keeps ids (and anything referencing them)
  // stable and makes the handler genuinely idempotent.
  if (storedRows.length === merged.length && lineItemsSignature(storedRows) === lineItemsSignature(merged)) return;

  await sb.from("order_line_items").delete().eq("order_id", orderId); // idempotent replace
  if (merged.length === 0) return;
  const { error } = await sb.from("order_line_items").insert(merged);
  if (error) throw error;
}

/** The columns matchFlorists reads off a florist row. */
const MATCH_FLORIST_COLUMNS =
  "id, place_id, email, network_id, email_shared_count, email_bounced_at, lat, lng, rating, " +
  "review_count, lifecycle_stage, excluded_at, source, trust_tier, delivery_radius_km, " +
  "capacity_per_day, is_test_shop";

/**
 * Every florist who could plausibly serve a delivery point, loaded by GEOGRAPHY.
 *
 * This used to load by `city_id`, where city_id came from an exact `ilike` on
 * the delivery address's city name — so an order in an uncovered suburb matched
 * NOBODY even with ten of our florists 3km away, and an order near a city edge
 * could never reach a florist sitting in the next city's ingest. Now that
 * matching has a hard distance cap, the cap IS the boundary and city membership
 * is only reporting metadata.
 *
 * The bounding box is what an index can serve; matchFlorists' exact haversine
 * then trims the corners, so the box being slightly generous costs a few rows
 * and nothing else. An order with no coordinates returns [] — we can't tell who
 * is near a place we couldn't locate, so it escalates to CX instead of being
 * offered to an arbitrary shop.
 */
export async function loadMatchableFlorists(
  sb: SupabaseClient,
  center: { lat: number | null; lng: number | null },
  capKm: number
): Promise<MatchFlorist[]> {
  if (center.lat == null || center.lng == null) return [];
  const box = boundingBox(center.lat, center.lng, capKm);
  const { data, error } = await sb.from("florists")
    .select(MATCH_FLORIST_COLUMNS)
    .is("deleted_at", null)
    .is("excluded_at", null)
    .in("lifecycle_stage", MATCHABLE)
    .gte("lat", box.minLat).lte("lat", box.maxLat)
    .gte("lng", box.minLng).lte("lng", box.maxLng);
  if (error) throw error;
  // Double cast: supabase-js can't infer a row type from a select list built by
  // string concatenation, so it falls back to GenericStringError[].
  const florists = (data ?? []) as unknown as MatchFlorist[];
  if (florists.length === 0) return florists;

  // Merge in each florist's all-time track record from the florist_stats view
  // (supabase/migrations/2026-07-15-florist-stats.sql) — feeds match.ts's
  // cold-start-guarded performance term. Best-effort: a florist with no row
  // in the view (shouldn't happen — the view left-joins from florists — but
  // never let a stats-fetch problem block matching) is left with the
  // optional fields undefined, which match.ts treats as cold-start/neutral.
  const stats = await loadFloristStats(sb, florists.map((f) => f.id));
  return florists.map((f) => {
    const s = stats.get(f.id);
    return s ? { ...f, acceptance_rate: s.acceptance_rate, on_time_rate: s.on_time_rate, sample_size: s.sample_size } : f;
  });
}

interface FloristStatsRow {
  acceptance_rate: number | null;
  on_time_rate: number | null;
  sample_size: number | null;
}

async function loadFloristStats(sb: SupabaseClient, floristIds: string[]): Promise<Map<string, FloristStatsRow>> {
  const map = new Map<string, FloristStatsRow>();
  if (floristIds.length === 0) return map;
  const { data, error } = await sb
    .from("florist_stats")
    .select("florist_id, acceptance_rate, on_time_rate, sample_size")
    .in("florist_id", floristIds);
  if (error) {
    // Never let a stats-fetch failure block order matching — fall back to
    // cold-start/neutral for everyone (matches match.ts's optional-field default).
    console.error("loadFloristStats failed:", error);
    return map;
  }
  for (const row of data ?? []) {
    map.set(row.florist_id as string, {
      acceptance_rate: row.acceptance_rate as number | null,
      on_time_rate: row.on_time_rate as number | null,
      sample_size: row.sample_size as number | null,
    });
  }
  return map;
}

/** How many assignments each of `floristIds` already has in accepted/delivered
 * status for the same calendar date (UTC) as `deliveryAt` (the order being
 * matched). Feeds match.ts's capacity_per_day hard filter. Returns a Map
 * defaulting to 0 for any florist not present (never undefined —
 * matchFlorists also guards with `?? 0`, but this keeps the contract honest
 * at the source).
 *
 * If `deliveryAt` is null there's no date to bucket by — rather than guessing
 * (e.g. treating it as "today"), capacity is simply not enforced for that
 * order: every florist gets 0 here, same as if nobody had any orders that day.
 *
 * Buckets by calendar date in JS rather than pushing the date range into a
 * PostgREST embedded-resource filter (`orders!inner(...)` + dotted-column
 * `.gte("orders.delivery_at", ...)`) — that's valid PostgREST syntax but this
 * repo has no existing precedent for it and there's no live Supabase in this
 * environment to verify it against, so this sticks to the plain nested-select
 * + in-JS-filter shape already used elsewhere in this file (e.g.
 * clawbackOrder). Candidate florist counts here are small (a handful of
 * per-city matches), so fetching all their accepted/delivered assignments and
 * filtering client-side is cheap. */
export async function countAcceptedForDay(
  sb: SupabaseClient,
  floristIds: string[],
  deliveryAt: string | null
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (floristIds.length === 0 || !deliveryAt) return counts;
  const targetDate = new Date(deliveryAt);
  if (Number.isNaN(targetDate.getTime())) return counts; // malformed delivery_at — don't guess, don't enforce
  const targetDayKey = targetDate.toISOString().slice(0, 10); // YYYY-MM-DD, UTC calendar date

  const { data, error } = await sb
    .from("order_assignments")
    .select("florist_id, orders(delivery_at)")
    .in("florist_id", floristIds)
    .in("status", ["accepted", "delivered"]);
  if (error) {
    console.error("countAcceptedForDay failed:", error);
    return counts; // best-effort — never block matching over a capacity-count failure
  }
  for (const row of (data ?? []) as Array<{ florist_id: string; orders: unknown }>) {
    const orderDeliveryAt = extractDeliveryAt(row.orders);
    if (!orderDeliveryAt) continue;
    const d = new Date(orderDeliveryAt);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== targetDayKey) continue;
    counts.set(row.florist_id, (counts.get(row.florist_id) ?? 0) + 1);
  }
  return counts;
}

/** The untyped supabase-js client can't statically tell whether a nested
 * to-one relation (order_assignments.order_id -> orders.id, which IS to-one)
 * comes back as an object or an array, so TS infers a generic shape here —
 * this normalizes either runtime shape rather than asserting one. */
function extractDeliveryAt(orders: unknown): string | null {
  const row = Array.isArray(orders) ? orders[0] : orders;
  const value = (row as { delivery_at?: unknown } | null | undefined)?.delivery_at;
  return typeof value === "string" ? value : null;
}

export async function insertCandidates(sb: SupabaseClient, orderId: string, candidates: Candidate[], deliveryAt: string | null, orderTotal: number): Promise<void> {
  // Idempotent: if this order already has candidates (webhook re-delivery), do nothing.
  const { count } = await sb.from("order_assignments").select("id", { count: "exact", head: true }).eq("order_id", orderId);
  if ((count ?? 0) > 0 || candidates.length === 0) return;
  const sla = deliveryAt ? new Date(new Date(deliveryAt).getTime() - 2 * 3600e3).toISOString() : null; // 2h before window
  // Lock in the florist's payout price (and the percent used) at match time, from
  // the admin-configurable default — see dashboard Settings → Payments. Locking it
  // in means a later change to the global default never retroactively changes what
  // was already offered for this order. Basis is the order's actual (post-discount)
  // total — see computePayoutPrice for why (a discount code is Facundo's to
  // absorb, not a reason to inflate the payout past what was actually collected).
  //
  // computePayoutPrice/floorPayout are IMPORTED from ./payoutMath, not
  // hand-duplicated here — the previous inline copy silently drifted from
  // dashboard/lib/payoutMath.ts's post-discount fix (real order #2000029,
  // 2026-08-17: a florist was overpaid €40 vs the €29 actually owed, because
  // this file kept computing the payout off the pre-discount item price while
  // the dashboard's manual re-match had already been fixed). ./payoutMath.ts is
  // a byte-identical copy of dashboard/lib/payoutMath.ts — see
  // dashboard/lib/payoutMath.test.mjs's byte-equality test, which fails the
  // build if the two ever diverge again.
  const { data: settings } = await sb.from("app_settings").select("default_payout_percent").eq("id", 1).single();
  const percent = settings?.default_payout_percent ?? 55;
  const payoutPrice = computePayoutPrice(orderTotal, percent);
  const rows = candidates.map((c, i) => ({
    order_id: orderId, florist_id: c.florist_id, rank: c.rank, florist_source: c.source,
    status: "candidate", offer_kind: i === 0 ? "exclusive" : "race", sla_deadline_at: sla,
    payout_price: payoutPrice, payout_percent: percent,
  }));
  const { error } = await sb.from("order_assignments").insert(rows);
  if (error) throw error;
}

export async function unwindOrder(sb: SupabaseClient, shopifyOrderId: string): Promise<string | null> {
  const { data: order } = await sb.from("orders").select("id").eq("shopify_order_id", shopifyOrderId).maybeSingle();
  if (!order) return null;
  await sb.from("orders").update({ status: "cancelled" }).eq("id", order.id);
  await sb.from("order_assignments").update({ status: "reassigned" }).eq("order_id", order.id).in("status", ["candidate", "queued", "sent", "opened", "accepted"]);
  await sb.from("order_events").insert({ order_id: order.id, type: "cancelled", actor: "system" });
  return order.id as string;
}

// Reclaim issued legs. Idempotent: skip if a clawback row already exists.
export async function clawbackOrder(sb: SupabaseClient, orderId: string, newPayoutTotal: number | null): Promise<void> {
  const { data: assigns } = await sb.from("order_assignments").select("id").eq("order_id", orderId);
  for (const a of assigns ?? []) {
    const { data: legs } = await sb.from("payouts").select("amount, status").eq("assignment_id", a.id);
    const issued = (legs ?? []).filter((p) => p.status === "issued").reduce((s, p) => s + (p.amount ?? 0), 0);
    const already = (legs ?? []).some((p) => p.status === "clawed_back");
    const reclaim = newPayoutTotal == null ? issued : Math.max(0, issued - newPayoutTotal);
    if (issued > 0 && !already && reclaim > 0) {
      await sb.from("payouts").insert({ assignment_id: a.id, leg: "accept", amount: -reclaim, currency: "EUR", status: "clawed_back" });
      await sb.from("order_events").insert({ order_id: orderId, type: "clawback", payload: { assignment_id: a.id, reclaim }, actor: "system" });
    }
  }
}

export async function setOrderStatus(sb: SupabaseClient, orderId: string, status: string): Promise<void> {
  const { error } = await sb.from("orders").update({ status }).eq("id", orderId);
  if (error) throw error;
}

/** Idempotently enqueue a `queued` ingest_jobs row for a city/country that had
 * no usable candidate for an order — instead of silently escalating, so the
 * Mac-mini poller (ingest/poll_jobs.py) picks it up and refills the florist
 * pool. Dedupes the SAME way the dashboard's POST /api/ingest already does
 * (an existing queued/running job for the same country+city), so many orders
 * hitting the same uncovered city in a row enqueue exactly one run, not one
 * per order. No-ops when the order's delivery address lacks a usable
 * city/country — the caller still records the `candidate_ingest_requested`
 * event so CX can see why no ingest was queued. */
export async function requestCandidateIngest(
  sb: SupabaseClient,
  p: { country: string | null; city: string | null; radiusKm: number },
): Promise<{ created: boolean; jobId: string | null }> {
  const country = p.country?.trim();
  const city = p.city?.trim();
  if (!country || !city) return { created: false, jobId: null };

  const { data: pending, error: selErr } = await sb
    .from("ingest_jobs")
    .select("id")
    .eq("country", country)
    .eq("city", city)
    .in("status", ["queued", "running"])
    .limit(1);
  if (selErr) throw selErr;
  if (pending && pending.length > 0) return { created: false, jobId: pending[0].id as string };

  const { data, error } = await sb
    .from("ingest_jobs")
    .insert({
      country, city, radius_km: p.radiusKm,
      keywords: null, language: null, // the CLI derives both per-country, same as the dashboard's batch-enqueue path
      reset_existing: false, status: "queued",
    })
    .select("id")
    .single();
  if (error) throw error;
  return { created: true, jobId: data.id as string };
}

export async function appendOrderEvent(sb: SupabaseClient, orderId: string, type: string, payload: object | null = null): Promise<void> {
  // Best-effort — an audit write must never abort intake.
  try { await sb.from("order_events").insert({ order_id: orderId, type, payload, actor: "system" }); }
  catch (e) { console.error("appendOrderEvent failed:", e); }
}

/** Record one call to an external service in the shared `external_ops` log
 * (backoffice → SYSTEM → External ops; same table dashboard/lib/externalOps.ts
 * writes, but this Worker needs its own copy — it can't import across the
 * package boundary). Best-effort, mirroring appendOrderEvent above: a logging
 * failure must never abort the caller (a reconcile sweep, a webhook handler),
 * so this never rethrows. */
export async function logExternalOp(
  sb: SupabaseClient,
  op: {
    provider: string;
    operation: string;
    direction: "in" | "out";
    orderId: string | null;
    ref: string | null;
    ok: boolean;
    error: string | null;
    meta?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    await sb.from("external_ops").insert({
      provider: op.provider,
      operation: op.operation,
      direction: op.direction,
      order_id: op.orderId,
      ref: op.ref,
      ok: op.ok,
      error: op.error,
      meta: op.meta ?? null,
    });
  } catch (e) { console.error("logExternalOp failed:", e); }
}

/** How automatic matching should treat test shops (florists WE own) right now.
 *
 * Fails SAFE: any read problem, or an unrecognized value, resolves to
 * 'exclude', so a settings hiccup can never route a paying customer's order to
 * a shop we only use for testing. See supabase/migrations/2026-08-05-test-shops.sql.
 */
/** The staff-tuned matching knobs (Settings → Matching). Never throws: a failed
 *  read yields DEFAULT_MATCH_CONFIG, because matching must not be the thing that
 *  breaks when a settings read does. Kept in step with the dashboard's
 *  lib/matchConfig.ts — both are thin reads around the same pure parser. */
export async function loadMatchConfig(sb: SupabaseClient): Promise<MatchConfig> {
  try {
    const { data } = await sb.from("app_settings").select(MATCH_CONFIG_COLUMNS).eq("id", 1).maybeSingle();
    return parseMatchConfig(data as Record<string, unknown> | null);
  } catch {
    return parseMatchConfig(null);
  }
}

export async function loadTestShopMatching(sb: SupabaseClient): Promise<TestShopMatching> {
  try {
    const { data } = await sb.from("app_settings").select("test_shop_matching").eq("id", 1).maybeSingle();
    return data?.test_shop_matching === "only" ? "only" : "exclude";
  } catch {
    return "exclude";
  }
}
