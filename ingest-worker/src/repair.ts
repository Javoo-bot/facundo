// Enrichment repair — the pure half. Deciding WHICH florists need repairing and
// WHAT may be written to them is all decidable without a database, so it lives
// here and is unit-tested; the I/O (select, patch, sweep) is in db.ts.
//
// See docs/superpowers/specs/2026-08-11-enrichment-repair-mode-design.md.

import { normalizePhone } from "./phones";
import { phoneRegionFor } from "./shopCountry";
import type { EnrichmentResult, RepairTarget, RepairPatch } from "./types";

/** Substrings in `enrichment_notes` that mean the last enrichment FAILED at
 * something, rather than succeeding and finding nothing.
 *
 * Deliberately not keyed on the vendor's error text. The 2026-08-06 incident
 * wrote "Your credit balance is too low to access the Anthropic API", and
 * matching on that would fix that outage and no other. These three cover the
 * shapes enrich.ts can actually record:
 *
 *   "... extraction failed (...)"  / "LLM classification failed (...)"
 *   "Homepage ... was unreachable" / "Link-in-bio target ... was unreachable"
 *   "Enrichment exceeded its time budget or raised"  (FAILED_ENRICHMENT)
 *
 * What they exclude is the case that matters most: a clean crawl where the
 * model looked and correctly concluded there is no genuine primary address
 * ("Email: 3 candidate(s) → none (no genuine primary email)"). Re-asking about
 * those is the one purely wasteful thing this job could do — 890 rows of it. */
export const REPAIR_FAILURE_PATTERNS = ["failed", "unreachable", "time budget"] as const;

/** The free-place-layer import (Overture Maps, no paid check — see
 * docs/agent-factory/tasks/002-free-florist-layer.md) seeds a florist with
 * enrichment_notes set to this placeholder ("Unchecked — email, phone and
 * owner unknown until the paid check.") instead of leaving it null. It means
 * exactly what null notes mean — enrichment never ran — but being non-null it
 * would otherwise read as a completed check that happened to find nothing. */
export const UNCHECKED_NOTES_PREFIX = "unchecked";

/** PostgREST `or=` filter for "the last enrichment did not produce an answer".
 *
 * THREE cases. A florist whose enrichment FAILED has notes saying so. A
 * florist enrichment NEVER REACHED has no notes at all: the pipeline persists
 * bare rows at step [6/8] and enriches at [7/8], so a run that dies in between
 * leaves rows with `enrichment_notes IS NULL` forever, and nothing retries
 * them. A free-layer import row never reached either, but carries the
 * "Unchecked ..." placeholder above instead of null.
 *
 * The NULL case is not hypothetical — Bordeaux's 2026-08-06 run failed at
 * [7/8] ("Attempt failed due to internal workflows error") after persisting
 * 133 bare rows, leaving 85 florists with a website, no email and no notes.
 * Matching only on recorded failures found 2 of them. 268 rows are in this
 * state overall.
 *
 * NULL notes can only mean un-enriched: every enrichment outcome writes a
 * string, including "No website on Maps listing — skipped enrichment."
 */
export function repairNotesFilter(): string {
  return [
    "enrichment_notes.is.null",
    `enrichment_notes.ilike.${UNCHECKED_NOTES_PREFIX}*`,
    ...REPAIR_FAILURE_PATTERNS.map((p) => `enrichment_notes.ilike.*${p}*`),
  ].join(",");
}

/** Does this row still need repairing? The DB query already filters on all of
 * this; this is the in-process re-check, so a row that changed between the
 * select and its turn in the pool (a long run — 105 florists at 5 concurrent)
 * is skipped rather than re-enriched pointlessly. */
export function needsRepair(row: RepairTarget): boolean {
  if (!row.website_url) return false;
  if (row.email) return false;
  if (row.deleted_at || row.excluded_at) return false;
  // No notes at all = enrichment never ran on this row (see repairNotesFilter).
  if (!row.enrichment_notes) return true;
  const notes = row.enrichment_notes.toLowerCase();
  if (notes.startsWith(UNCHECKED_NOTES_PREFIX)) return true;
  return REPAIR_FAILURE_PATTERNS.some((p) => notes.includes(p));
}

/**
 * The write-back patch: what a fresh enrichment is ALLOWED to change on a row
 * that already exists.
 *
 * Null-only fill. A field is written only where the current value is null, so
 * the repair can never overwrite an address staff corrected by hand or a
 * florist supplied themselves. (`email` is null by definition of the target
 * set, but the run is long and this function is also the guard for the other
 * five fields, which a partially-successful enrichment may well have filled.)
 *
 * Three groups of columns are deliberately absent:
 *
 *   - Maps-sourced (name, address, lat, lng, rating, review_count, phone_maps,
 *     category_name, categories) — we did not re-scrape them, so we have
 *     nothing newer to say and would only risk writing a regression.
 *   - Lifecycle/ownership (deleted_at, excluded_at, lifecycle_stage, joined_at,
 *     trust_tier, locale, drafted_email) — none of it is enrichment's to touch.
 *     This is also why the caller uses update(), not upsert() with buildRow:
 *     buildRow hardcodes `deleted_at: null` and would resurrect a soft-deleted
 *     florist.
 *   - has_website — the row is in the target set BECAUSE it has a website_url.
 *
 * `enrichment_notes` is always written: it is a diagnostic of the most recent
 * attempt, and leaving the stale credit-balance text on a successfully repaired
 * row would be actively misleading.
 */
export function buildRepairPatch(
  current: RepairTarget,
  fresh: EnrichmentResult,
  phoneRegion: string | null,
  /** domain → network id, from `florist_networks`. Empty map = no linking. */
  networkRegistry: Map<string, string> = new Map()
): RepairPatch {
  const patch: RepairPatch = {
    enrichment_notes: fresh.enrichment_notes ?? null,
    enrichment_ai_context: fresh.enrichment_ai_context ?? null,
  };

  // Link the shop to a known network/franchise/directory whose site hosts its
  // page. Set BEFORE the email below is even considered, because the two are
  // independent signals: emailSkipReason suppresses the email leg on network_id
  // alone, so a linked shop is protected even when it is the only florist
  // holding that address and the shared-count sweep therefore sees nothing.
  if (current.network_id == null) {
    const networkId = matchNetworkId(current.website_url, networkRegistry);
    if (networkId) patch.network_id = networkId;
  }

  if (current.email == null && fresh.email != null) patch.email = fresh.email;
  if (current.phone_web == null && fresh.phone_web != null) {
    // Same normalization the ingest row builder applies, so a repaired number
    // is indistinguishable from a freshly-ingested one — including its
    // never-drop-data contract: an unparseable number is stored verbatim rather
    // than discarded, for a human to look at.
    patch.phone_web = normalizePhone(fresh.phone_web, phoneRegionFor(current.address, phoneRegion)) as string;
  }
  if (current.owner_name == null && fresh.owner_name != null) patch.owner_name = fresh.owner_name;
  if (current.shop_highlight == null && fresh.shop_highlight != null) {
    patch.shop_highlight = fresh.shop_highlight;
  }
  if (current.is_ecommerce == null && fresh.is_ecommerce != null) {
    patch.is_ecommerce = fresh.is_ecommerce;
  }
  if (current.ecommerce_signals == null && fresh.ecommerce_signals != null) {
    patch.ecommerce_signals = fresh.ecommerce_signals;
  }

  return patch;
}

/** Did this patch actually add an email? Drives two things: whether the run
 * bothers with the (global, whole-table) shared-email sweep at the end, and the
 * number the job log reports as the repair's result. */
export function patchAddsEmail(patch: RepairPatch): boolean {
  return typeof patch.email === "string" && patch.email.length > 0;
}

/**
 * How many florists share each email address. Port of
 * ingest/networks.py::shared_email_counts.
 *
 * An address shared by more than one shop identifies none of them, so the offer
 * path stops using it (dashboard/lib/offerChannels.ts::emailSkipReason). This
 * repair writes ~1,700 fresh addresses in one go; without rescoring, matching
 * would happily send several offers for one order into a single shared inbox —
 * the failure lib/lifecycle.ts records as four offers to contact@reseau-demo.fr.
 *
 * Case and surrounding whitespace are folded, because they are never a real
 * difference between two mailboxes. Gmail dots and +tags deliberately are NOT:
 * for a business address the local part usually means something, and wrongly
 * merging two real inboxes silently drops a prospect.
 */
export function sharedEmailCounts(rows: Array<{ email?: string | null }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const email = (row.email ?? "").trim().toLowerCase();
    if (!email) continue; // no address is not a shared address
    counts.set(email, (counts.get(email) ?? 0) + 1);
  }
  return counts;
}

// --- network domains -------------------------------------------------------
// Port of ingest/networks.py's registrable_domain + match_network. The worker
// never got these at the cutover, which is why no florist ingested since has
// been linked to a network. It matters here because the repair WRITES
// addresses: a dry run over six real Toulouse rows recovered contact@artisans-demo.fr
// (Artisans Fleuristes Demo, a trade directory) and contact@reseau-demo.fr —
// the very address lib/lifecycle.ts records as four offers for one order
// landing in one inbox. The shared-count sweep catches those two only because
// many shops happen to hold them; a network address that exactly one florist
// ends up with stays unflagged, and this is the signal that catches it.

/** Second-level labels that are part of the SUFFIX, not the registrable name
 * ('co.uk', 'com.ar', 'com.au'). Derived rather than enumerated, because a
 * hand-written list silently omits whichever country is ingested next — an
 * early version of the Python original collapsed every Argentine shop to the
 * domain 'com.ar' and duly proposed it as a 46-shop network. */
const GENERIC_SECOND_LEVELS = new Set([
  "com", "co", "net", "org", "edu", "gov", "mil", "int", "biz", "info",
  "ac", "or", "ne", "gob", "gouv", "govt", "asso", "nom", "web", "tm",
  "ltd", "plc", "me", "priv", "firm", "gen", "ind",
]);

/** Two-part suffixes that don't fit the rule above (a non-generic second level,
 * or a TLD longer than two letters). Extend as they turn up. */
const EXTRA_TWO_PART_SUFFIXES = new Set(["nom.es", "org.uk", "sch.uk", "co.com"]);

function hasTwoPartSuffix(labels: string[]): boolean {
  if (labels.length < 3) return false;
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  if (tld.length === 2 && GENERIC_SECOND_LEVELS.has(second)) return true;
  return EXTRA_TWO_PART_SUFFIXES.has(`${second}.${tld}`);
}

/** The registrable ("eTLD+1") domain of a URL or bare hostname, lowercased.
 * Returns null for anything without a usable host, so a caller can treat "no
 * website" and "unparseable website" identically. */
export function registrableDomain(urlOrHost: string | null | undefined): string | null {
  const trimmed = (urlOrHost ?? "").trim();
  if (!trimmed) return null;
  // URL only parses with a scheme; a bare hostname needs one added.
  const raw = trimmed.includes("//") ? trimmed : `https://${trimmed}`;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "").replace(/\.+$/, "");
  if (!host || !host.includes(".")) return null;
  const labels = host.split(".");
  return hasTwoPartSuffix(labels) ? labels.slice(-3).join(".") : labels.slice(-2).join(".");
}

/** The network id whose domain owns `websiteUrl`, or null. `registry` maps a
 * registrable domain to its network id (the `florist_networks` table). */
export function matchNetworkId(
  websiteUrl: string | null,
  registry: Map<string, string>
): string | null {
  const domain = registrableDomain(websiteUrl);
  if (!domain) return null;
  return registry.get(domain) ?? null;
}

/** The `email_shared_count` a row SHOULD carry, given the tallied counts. A
 * florist with no email is 1 (unshared), matching the Python original — the
 * column means "how many shops answer at this address", and no address is not
 * a shared one. */
export function wantedSharedCount(
  email: string | null | undefined,
  counts: Map<string, number>
): number {
  const key = (email ?? "").trim().toLowerCase();
  if (!key) return 1;
  return counts.get(key) ?? 1;
}
