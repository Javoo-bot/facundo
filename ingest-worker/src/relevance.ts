// Florist relevance filter — pure/testable pieces. Port of ingest/relevance.py.
//
// Two-stage check per scraped place:
//   1. Free rule (categoryMatchesFlorist): does Google's own Maps category
//      contain one of the country's localized florist search keywords? If
//      so, keep it — no LLM call needed.
//   2. Ambiguous fallback (classifyRelevance): one LLM call (Sonnet-5 via
//      OpenRouter)
//      judges is_florist using the place's name/address/category/rating —
//      no extra fetch needed.
//
// The async orchestration (bounded concurrency, fail-open on an LLM-call
// exception, the lifecycle-stage "vouched" bypass) lives in workflow.ts, NOT
// here — every LLM call inside a Cloudflare Workflow must be wrapped in
// its own step.do() for correct replay/memoization (see workflow.ts's
// existing per-florist enrichment step for the same pattern), so the
// try/catch + step wiring has to live where the step.do calls are made.
import type { LlmClient } from "./openrouter";
import { MODEL_FOR_CALL } from "./config";
import { structured, RELEVANCE_SCHEMA } from "./llm";
import { relevanceClassificationPrompt } from "./prompts";
import type { RecordedUsage } from "./enrich";
import type { RelevanceClassification, ScrapedFlorist } from "./types";

/**
 * Category markers that DISQUALIFY the free keyword rule below.
 *
 * The free rule is a substring test, and some Google categories contain a
 * florist keyword while describing a business that cannot fulfil a fresh-flower
 * order. The one that actually bit us: the French keyword "magasin de fleurs"
 * is a prefix of **"Magasin de fleurs séchées"** (dried flowers), the secondary
 * category every CBD shop carries — so on 2026-08-06 twelve cannabis shops were
 * waved through with no LLM call at all, in a run where the LLM was down anyway.
 *
 * A marker does NOT drop the place. It only revokes the free pass and sends it
 * to the LLM for a real judgment, because these are genuinely ambiguous
 * ("Fleuriste grossiste" is a wholesaler; some also sell retail) and a
 * hard-coded drop would be a permanent, silent false negative.
 */
export const NON_FLORIST_CATEGORY_MARKERS = [
  // dried / preserved — not fresh arrangements. Also what CBD shops file under.
  "séchées", "sechees", "secas", "dried", "preserved",
  // wholesale — not consumer-facing
  "grossiste", "mayorista", "wholesale",
  // cannabis / CBD, which trade on the word "fleurs"
  "cannabis", "cbd", "weed",
  // artificial
  "artificielle", "artificial", "artificiales",
  // Funeral homes — French ones commonly carry "Fleuriste" as a secondary
  // Maps category (arranging funeral flowers is part of the business), but
  // they aren't a florist for fresh-order-fulfillment purposes. Real case
  // (2026-09-04): "Pompes Funèbres Exemple", primary category "Entreprise de
  // pompes funèbres", got the free pass — no LLM call at all — and a real
  // order offer went out to it, because "Fleuriste" was one of 8 secondary
  // categories on its Maps listing.
  "pompes funèbres", "pompes funebres", "funéraire", "funeraire", "obsèques", "obseques",
  "funeral", "funeraria", "funebre", "bestattung",
];

/** True if any category names something the markers above disqualify. */
export function hasNonFloristMarker(
  categoryName: string | null | undefined,
  categories: string[] | null | undefined
): boolean {
  const combined = [categoryName ?? "", ...(categories ?? [])].join(" ").toLowerCase();
  if (!combined.trim()) return false;
  return NON_FLORIST_CATEGORY_MARKERS.some((marker) => combined.includes(marker));
}

/**
 * True if `categoryName` or any entry in `categories` contains one of
 * `keywordList`'s terms as a case-insensitive substring — the free "obviously a
 * florist, don't spend an LLM call" rule.
 *
 * Returns false when a disqualifying marker is present, even if a keyword also
 * matches, so the place falls through to LLM judgment instead of being kept for
 * free (see NON_FLORIST_CATEGORY_MARKERS).
 */
export function categoryMatchesFlorist(
  categoryName: string | null | undefined,
  categories: string[] | null | undefined,
  keywordList: string[]
): boolean {
  const hasKeyword = (text: string): boolean => {
    const t = text.toLowerCase();
    return keywordList.some((keyword) => t.includes(keyword.toLowerCase()));
  };

  // Google's PRIMARY category is the strongest signal, and it settles the case
  // the markers would otherwise get wrong. Plenty of real florists carry
  // "Magasin de fleurs séchées" as a *secondary* category — "Exemple Fleurs |
  // Fleuriste" sells dried flowers too — and they must keep the free pass. The
  // CBD shops are distinguishable precisely here: their primary category is
  // "Magasin de cannabis" and only a secondary one mentions flowers.
  if (categoryName && hasKeyword(categoryName) && !hasNonFloristMarker(categoryName, null)) return true;

  // No florist primary. A keyword anywhere in the secondary categories still
  // earns the free pass, unless a marker disqualifies the place — which is what
  // sends CBD shops, wholesalers ("Fleuriste grossiste" is a keyword match AND
  // a marker, in the primary) and dried-flower shops to the LLM instead.
  const haystacks: string[] = [];
  if (categoryName) haystacks.push(categoryName);
  if (categories) haystacks.push(...categories);
  if (haystacks.length === 0) return false;
  if (hasNonFloristMarker(categoryName, categories)) return false;
  return hasKeyword(haystacks.join(" "));
}

/**
 * True if Google gave us essentially nothing to work with — no Maps category
 * at all. A genuine Places business result, even a bare-bones one, virtually
 * always carries SOME category from Google; an item with none is
 * characteristic of a locality/administrative-area result the search radius
 * pulled in, not a real business.
 *
 * Real case (2026-09-04, order #2000033): "Mesterrieux", "Neuffons",
 * "Loubens" etc. — Landerrouet-sur-Ségur candidates named after neighboring
 * communes, address "<postcode>, France" (no street), category_name null,
 * categories []. With nothing but a bare place name to judge, the relevance
 * LLM's deliberate "keep when uncertain" bias (see this file's module
 * docstring) waved every one of them through as a florist — a real order
 * got matched to, and offered to, phantom "florists" that are just village
 * names. Checked BEFORE the LLM call, not after: this is cheaper AND more
 * reliable than hoping the LLM catches an empty-data case correctly.
 */
export function looksLikeRealBusiness(
  categoryName: string | null | undefined,
  categories: string[] | null | undefined
): boolean {
  if (categoryName && categoryName.trim()) return true;
  if (categories && categories.length > 0) return true;
  return false;
}

/**
 * Is the relevance filter systemically broken, rather than having merely lost a
 * few calls?
 *
 * Every individual failure is deliberately fail-open — one bad call must not
 * soft-delete a real florist. But fail-open across the board means "keep
 * everything", and on 2026-08-06 that is exactly what shipped: the Anthropic
 * account hit zero credit, all 3 runs made 0 successful calls, each logged
 * "Nothing filtered: every result looked like a florist", each reported SUCCESS,
 * and 610 places landed in the florist table including 80 lottery kiosks and a
 * royal palace garden.
 *
 * So the per-call policy stays fail-open and the RUN fails instead: an outage
 * should look like a failed job, not a successful one with unusable data.
 */
export function isRelevanceOutage(attempts: number, failures: number): boolean {
  if (attempts === 0) return false;
  if (attempts >= 3 && failures === attempts) return true;   // nothing got through
  return attempts >= 10 && failures / attempts >= 0.5;       // more than half lost
}

export async function classifyRelevance(
  llm: LlmClient,
  florist: Pick<ScrapedFlorist, "place_id" | "name" | "address" | "category_name" | "categories" | "rating" | "review_count">,
  usages: RecordedUsage[]
): Promise<RelevanceClassification> {
  const model = MODEL_FOR_CALL.relevance;
  const { parsed, usage } = await structured<RelevanceClassification>(
    llm,
    model,
    relevanceClassificationPrompt(
      florist.name ?? "(unknown)",
      florist.address ?? "(unknown)",
      florist.category_name ?? "(none)",
      (florist.categories ?? []).join(", ") || "(none)",
      florist.rating,
      florist.review_count
    ),
    RELEVANCE_SCHEMA,
    256,
    // No row keeps a relevance verdict (a rejected place is never stored), so
    // the Langfuse trace is the only record of what Bloom was shown.
    { agent: "bloom", name: "relevance", sessionId: florist.place_id, metadata: { place: florist.name } }
  );
  usages.push({ callType: "relevance", model, usage });
  return parsed;
}
