// Apify wrapper — scrapes Google Maps florist listings via
// `compass/crawler-google-places` and normalizes the raw fields we care
// about.
//
// Ported from ingest/scrape.py. Uses the Apify REST API directly via fetch
// (not the `apify-client` node package, which isn't Workers-friendly):
// start a run, poll until terminal, then read the dataset's items.
//
// See scrape.py's module docstring for the full rationale on
// `customGeolocation` (coordinate order [lng, lat] + radiusKm), localized
// keywords/language, and why `maps_online_order` is derived from
// `additionalInfo` labels (True on a positive match, else null — an honest
// unknown, not False).

import { APIFY_ACTOR_ID, ONLINE_ORDER_LABEL_KEYWORDS } from "./config";
import type { ScrapedFlorist } from "./types";

const POLL_INTERVAL_MS = 5000;
const MAX_POLL_ITERATIONS = 120;

// The actor's `language` input validates against Google's legacy Maps
// language codes, which diverge from standard ISO 639-1 for a couple of
// languages — Hebrew is "iw", not "he" (2026-09-03: every IL ingest run was
// failing with the actor's 400 "must be equal to one of the allowed values"
// before this landed, because keywords.ts/Claude correctly derives "he").
// KEEP IN STEP with ingest/scrape.py::APIFY_LANGUAGE_OVERRIDES.
export const APIFY_LANGUAGE_OVERRIDES: Record<string, string> = { he: "iw" };

/** What one place costs, measured across three Apify runs on 2026-09-09
 * (279 -> $1.12, 285 -> $1.14, 285 -> $1.14). Explanatory only. */
export const USD_PER_PLACE = 0.004;

/**
 * Split a per-CITY place budget across the keywords that will run.
 *
 * `maxCrawledPlacesPerSearch` is applied PER SEARCH STRING, so N keywords at L
 * each can return up to N*L places. That made the caller's "limit" a number
 * that did not mean what it said, and the bill followed the keyword list rather
 * than the operator's intent: Spain has EIGHT keywords, so a run asked for
 * "limit 40" scraped 285 places and cost $1.14 against a $6/month allowance.
 *
 * Ceiling division, floored at 1: with more keywords than budget every keyword
 * still gets one place rather than being silently switched off, which keeps a
 * small budget from quietly becoming a single-keyword search.
 *
 * KEEP IN STEP with ingest/scrape.py::per_search_cap.
 */
export function perSearchCap(maxPlaces: number, keywordCount: number): number {
  if (!Number.isFinite(maxPlaces) || maxPlaces < 1) return 1;
  if (!Number.isFinite(keywordCount) || keywordCount <= 0) return Math.max(1, Math.floor(maxPlaces));
  return Math.max(1, Math.ceil(maxPlaces / keywordCount));
}

const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);

interface ApifyRunResponse {
  data: {
    id: string;
    defaultDatasetId: string;
    status: string;
    usageTotalUsd?: number | null;
  };
}

/** Raw shape of one Apify `compass/crawler-google-places` dataset item —
 * only the fields we read. Everything else on the item is ignored. */
export interface ApifyPlaceItem {
  placeId?: string | null;
  title?: string | null;
  address?: string | null;
  location?: { lat?: number | null; lng?: number | null } | null;
  totalScore?: number | null;
  reviewsCount?: number | null;
  phone?: string | null;
  website?: string | null;
  categoryName?: string | null;
  categories?: string[] | null;
  additionalInfo?: Record<string, Array<Record<string, boolean>> | null | undefined> | null;
  [key: string]: unknown;
}

/** Best-effort Maps "online ordering" signal from `additionalInfo` — see the
 * module docstring for what was checked and why. Returns true on a positive
 * label match, else null (honest unknown, not false). */
export function extractMapsOnlineOrder(item: ApifyPlaceItem): boolean | null {
  const additionalInfo = item.additionalInfo || {};
  for (const entries of Object.values(additionalInfo)) {
    for (const entry of entries || []) {
      if (!entry) continue;
      for (const [label, value] of Object.entries(entry)) {
        if (value && ONLINE_ORDER_LABEL_KEYWORDS.some((keyword) => label.toLowerCase().includes(keyword))) {
          return true;
        }
      }
    }
  }
  return null;
}

/** Normalize + dedup-by-`place_id` raw Apify dataset items into
 * `ScrapedFlorist`s. Items with no `placeId`, or a `placeId` already seen,
 * are dropped — that field is the dedup key on the `florists` table and a
 * row without it can't be upserted safely. */
export function normalizeItems(items: ApifyPlaceItem[], maxPlaces?: number): ScrapedFlorist[] {
  const normalized: ScrapedFlorist[] = [];
  const seenPlaceIds = new Set<string>();

  for (const item of items) {
    const placeId = item.placeId;
    if (!placeId || seenPlaceIds.has(placeId)) continue;
    seenPlaceIds.add(placeId);

    const location = item.location || {};
    normalized.push({
      place_id: placeId,
      name: item.title ?? null,
      address: item.address ?? null,
      lat: location.lat ?? null,
      lng: location.lng ?? null,
      rating: item.totalScore ?? null,
      review_count: item.reviewsCount ?? null,
      phone_maps: item.phone ?? null,
      website_url: item.website ?? null,
      category_name: item.categoryName ?? null,
      categories: item.categories ?? null,
      maps_online_order: extractMapsOnlineOrder(item),
    });
    // The per-search cap rounds UP, so N keywords can collectively return a few
    // more than the city budget. Truncating makes `limit` mean exactly what it
    // says rather than "roughly this". It saves no money — the actor already
    // crawled them — it keeps the number honest and stops one dense city
    // quietly enriching 30 shops when the operator asked for 25.
    if (maxPlaces !== undefined && normalized.length >= maxPlaces) break;
  }

  return normalized;
}

/** Start an Apify actor run (non-idempotent — each call is a NEW, separately
 * billed run). Returns the run id + dataset id so polling/collection can be a
 * SEPARATE, idempotent step: a retry of the collection step must re-poll this
 * same run, never start a new one. */
export async function startApifyRun(opts: {
  token: string;
  centerLat: number;
  centerLng: number;
  radiusKm: number;
  limit: number;
  keywords: string[];
  language: string;
}): Promise<{ runId: string; datasetId: string }> {
  const { token, centerLat, centerLng, radiusKm, limit, keywords, language } = opts;
  const runInput = {
    searchStringsArray: keywords,
    customGeolocation: { type: "Point", coordinates: [centerLng, centerLat], radiusKm },
    // `limit` is the budget for the CITY; the actor wants a per-search number.
    // Deriving it here is the point — the caller should not have to know how
    // many keywords this country has to predict what it will be billed.
    maxCrawledPlacesPerSearch: perSearchCap(limit, keywords.length),
    language: APIFY_LANGUAGE_OVERRIDES[language] ?? language,
  };
  const startResponse = await fetch(
    `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${encodeURIComponent(token)}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(runInput) }
  );
  if (!startResponse.ok) {
    throw new Error(`Apify run start failed with status ${startResponse.status}: ${await startResponse.text()}`);
  }
  const startBody = (await startResponse.json()) as ApifyRunResponse;
  return { runId: startBody.data.id, datasetId: startBody.data.defaultDatasetId };
}

/** Poll an EXISTING run to completion, then fetch + normalize its dataset
 * items. Idempotent: safe to retry (re-polls the same run, never starts one).
 * Returns florists + the run's actual USD charge. */
export async function collectApifyResults(
  token: string,
  runId: string,
  datasetId: string,
  /** The city's place budget, so the collected set matches what was asked for.
   * Optional so an existing caller that omits it keeps today's behaviour. */
  maxPlaces?: number
): Promise<{ florists: ScrapedFlorist[]; apifyCostUsd: number | null }> {
  let finalStatus = "";
  let usageTotalUsd: number | null | undefined;
  let iterations = 0;
  while (!TERMINAL_STATUSES.has(finalStatus)) {
    if (iterations >= MAX_POLL_ITERATIONS) {
      throw new Error(
        `Apify actor run ${runId} did not reach a terminal state after ${MAX_POLL_ITERATIONS} polls (last status: ${finalStatus})`
      );
    }
    if (iterations > 0) await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const pollResponse = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${encodeURIComponent(token)}`
    );
    if (!pollResponse.ok) {
      throw new Error(`Apify run poll failed with status ${pollResponse.status}: ${await pollResponse.text()}`);
    }
    const pollBody = (await pollResponse.json()) as ApifyRunResponse;
    finalStatus = pollBody.data.status;
    usageTotalUsd = pollBody.data.usageTotalUsd;
    iterations += 1;
  }
  if (finalStatus !== "SUCCEEDED") {
    throw new Error(`Apify actor run ${runId} finished with non-success status: ${finalStatus}`);
  }
  const apifyCostUsd = typeof usageTotalUsd === "number" ? usageTotalUsd : null;

  const itemsResponse = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(token)}&clean=true`
  );
  if (!itemsResponse.ok) {
    throw new Error(`Apify dataset items fetch failed with status ${itemsResponse.status}: ${await itemsResponse.text()}`);
  }
  const items = (await itemsResponse.json()) as ApifyPlaceItem[];
  return { florists: normalizeItems(items, maxPlaces), apifyCostUsd };
}

/** Convenience one-shot (start + collect) for non-Workflow callers (e.g. a
 * manual/local script). The Workflow deliberately calls startApifyRun and
 * collectApifyResults as SEPARATE steps so a step retry never re-bills a run. */
export async function scrapeFlorists(opts: {
  token: string;
  centerLat: number;
  centerLng: number;
  radiusKm: number;
  limit: number;
  keywords: string[];
  language: string;
}): Promise<{ florists: ScrapedFlorist[]; apifyCostUsd: number | null }> {
  const { runId, datasetId } = await startApifyRun(opts);
  return collectApifyResults(opts.token, runId, datasetId, opts.limit);
}
