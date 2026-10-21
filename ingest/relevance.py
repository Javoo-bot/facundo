"""Florist relevance filter — drops Google Maps hits that matched a florist
search keyword but aren't actually florists (a supermarket with a flower
counter, a gift shop, a garden center, a wholesaler, etc.), before they're ever
persisted or enriched.

Two-stage check per scraped place:
  1. Free rule: does Google's own Maps category (`category_name`/`categories`,
     captured in scrape.py) contain one of the country's localized florist
     search keywords (the same list keywords.py derives per-country)? If so,
     keep it — no Claude call needed. This is the common case: a genuine
     florist search hit is normally Maps-categorized as "Florist" (or its
     localized equivalent), which is exactly what's in that country's keyword
     list.
  2. Ambiguous fallback: no category match (wrong category, or none at all) ->
     one Claude call (Sonnet-5, see usage.py) judges is_florist using the
     place's name/address/category/rating — no extra fetch, everything needed
     is already in hand from the scrape.

A "false" from the Claude fallback is PERMANENT: the caller (main.py) never
persists a bare row for it, so it's never seen again. Given that, the fallback
prompt is biased toward keeping when genuinely uncertain, and a Claude-call
failure fails OPEN (keeps the place) rather than silently dropping a possible
real florist over a transient API error.
"""

import asyncio
import sys

from prompts import RELEVANCE_CLASSIFICATION_PROMPT, RelevanceClassification
from usage import MODEL_FOR_CALL

MAX_CONCURRENT_RELEVANCE_CALLS = 10

# Category markers that DISQUALIFY the free keyword rule below.
#
# The free rule is a substring test, and some Google categories contain a
# florist keyword while describing a business that cannot fulfil a
# fresh-flower order. A marker does NOT drop the place — it only revokes the
# free pass and sends it to Claude for a real judgment, because these are
# genuinely ambiguous (some businesses in these categories DO also run a real
# florist) and a hard-coded drop would be a permanent, silent false negative.
# KEEP IN STEP with ingest-worker/src/relevance.ts::NON_FLORIST_CATEGORY_MARKERS.
NON_FLORIST_CATEGORY_MARKERS = [
    # dried / preserved — not fresh arrangements. Also what CBD shops file under.
    "séchées", "sechees", "secas", "dried", "preserved",
    # wholesale — not consumer-facing
    "grossiste", "mayorista", "wholesale",
    # cannabis / CBD, which trade on the word "fleurs"
    "cannabis", "cbd", "weed",
    # artificial
    "artificielle", "artificial", "artificiales",
    # Funeral homes — French ones commonly carry "Fleuriste" as a secondary
    # Maps category (arranging funeral flowers is part of the business), but
    # they aren't a florist for fresh-order-fulfillment purposes. Real case
    # (2026-09-04, order #2000033): "Pompes Funèbres Exemple", primary
    # category "Entreprise de pompes funèbres", got the free pass — no LLM
    # call at all — and a real order offer went out to it, because
    # "Fleuriste" was one of 8 secondary categories on its Maps listing.
    "pompes funèbres", "pompes funebres", "funéraire", "funeraire", "obsèques", "obseques",
    "funeral", "funeraria", "funebre", "bestattung",
]


def has_non_florist_marker(category_name: str | None, categories: list[str] | None) -> bool:
    """True if any category names something NON_FLORIST_CATEGORY_MARKERS disqualifies."""
    combined = " ".join(str(h) for h in [category_name or "", *(categories or [])]).lower()
    if not combined.strip():
        return False
    return any(marker in combined for marker in NON_FLORIST_CATEGORY_MARKERS)


def category_matches_florist(
    category_name: str | None, categories: list[str] | None, keyword_list: list[str]
) -> bool:
    """True if `category_name` or any entry in `categories` contains one of
    `keyword_list`'s terms as a case-insensitive substring — UNLESS a
    NON_FLORIST_CATEGORY_MARKERS marker disqualifies it (see there for why
    that's a "send to Claude", not a hard drop).

    Google's PRIMARY category is the strongest signal and settles the case a
    marker-only check would get wrong: a real florist that ALSO sells dried
    flowers (primary "Fleuriste", secondary "Magasin de fleurs séchées") must
    keep the free pass, while a CBD shop (primary "Magasin de cannabis",
    secondary mentions flowers) must not.
    """

    def has_keyword(text: str) -> bool:
        t = text.lower()
        return any(keyword.lower() in t for keyword in keyword_list)

    if category_name and has_keyword(category_name) and not has_non_florist_marker(category_name, None):
        return True

    haystacks: list[str] = []
    if category_name:
        haystacks.append(category_name)
    if categories:
        haystacks.extend(categories)
    if not haystacks:
        return False
    if has_non_florist_marker(category_name, categories):
        return False
    return has_keyword(" ".join(str(h) for h in haystacks))


def looks_like_real_business(category_name: str | None, categories: list[str] | None) -> bool:
    """True if Google gave us essentially nothing to work with — no Maps
    category at all. A genuine Places business result, even a bare-bones
    one, virtually always carries SOME category from Google; an item with
    none is characteristic of a locality/administrative-area result the
    search radius pulled in, not a real business.

    Real case (2026-09-04, order #2000033): "Mesterrieux", "Neuffons",
    "Loubens" etc. — Landerrouet-sur-Ségur candidates named after
    neighboring communes, address "<postcode>, France" (no street),
    category_name None, categories []. With nothing but a bare place name
    to judge, the relevance Claude call's deliberate "keep when uncertain"
    bias (see this module's docstring) waved every one of them through as
    a florist — a real order got matched to, and offered to, phantom
    "florists" that are just village names. Checked BEFORE the Claude
    call, not after: cheaper AND more reliable than hoping Claude catches
    an empty-data case correctly. KEEP IN STEP with
    ingest-worker/src/relevance.ts::looksLikeRealBusiness.
    """
    if category_name and category_name.strip():
        return True
    return bool(categories)


async def _classify_relevance(claude_client, florist: dict, tracker) -> RelevanceClassification:
    prompt = RELEVANCE_CLASSIFICATION_PROMPT.format(
        name=florist.get("name") or "(unknown)",
        address=florist.get("address") or "(unknown)",
        category_name=florist.get("category_name") or "(none)",
        categories=", ".join(florist.get("categories") or []) or "(none)",
        rating=florist.get("rating"),
        review_count=florist.get("review_count"),
    )
    model = MODEL_FOR_CALL["relevance"]
    response = await asyncio.to_thread(
        claude_client.messages.parse,
        model=model,
        max_tokens=256,
        messages=[{"role": "user", "content": prompt}],
        output_format=RelevanceClassification,
    )
    if tracker is not None:
        tracker.record("relevance", model, response)
    return response.parsed_output


async def filter_florists_by_relevance(
    florists: list[dict],
    keyword_list: list[str],
    claude_client,
    tracker,
    vouched_place_ids: set[str] | None = None,
) -> tuple[list[dict], list[dict]]:
    """Partition `florists` into (kept, dropped). Places whose Maps category
    matches `keyword_list` are kept for free; the rest are judged concurrently
    by Claude (bounded by MAX_CONCURRENT_RELEVANCE_CALLS, mirroring
    enrich.py's semaphore pattern). See module docstring for the fail-open and
    bias-toward-keeping rationale.

    `vouched_place_ids` (typically already-onboarded florists — see
    db.get_place_ids_with_advanced_lifecycle) are kept unconditionally, without
    running the category rule OR the Claude fallback: a place a human has
    already acted on must never be silently dropped by a re-scrape.
    """
    vouched = vouched_place_ids or set()
    kept: list[dict] = []
    ambiguous: list[dict] = []
    dropped: list[dict] = []
    for florist in florists:
        category_name = florist.get("category_name")
        categories = florist.get("categories")
        if florist["place_id"] in vouched:
            kept.append(florist)
        elif not looks_like_real_business(category_name, categories):
            # Dropped before ever reaching Claude — see
            # looks_like_real_business for why an item with literally no
            # Maps category is treated as noise (a locality result, not a
            # business) rather than sent to the relevance judge.
            florist["_relevance_reason"] = (
                f'"{florist.get("name")}" has no Maps category at all — likely a '
                "locality/administrative-area result, not a real business."
            )
            dropped.append(florist)
        elif category_matches_florist(category_name, categories, keyword_list):
            kept.append(florist)
        else:
            ambiguous.append(florist)

    semaphore = asyncio.Semaphore(MAX_CONCURRENT_RELEVANCE_CALLS)

    async def _judge(florist: dict) -> None:
        async with semaphore:
            try:
                result = await _classify_relevance(claude_client, florist, tracker)
                if result.is_florist:
                    kept.append(florist)
                else:
                    florist["_relevance_reason"] = (
                        f'"{florist.get("name")}" ({florist.get("category_name") or "no category"}) — '
                        f"Claude judged non-florist: {result.reasoning} (confidence={result.confidence:.2f})"
                    )
                    dropped.append(florist)
            except Exception as exc:  # noqa: BLE001 - fail open: never silently lose a possible real florist
                print(
                    f"[relevance] Claude relevance judging failed for "
                    f"{florist.get('name')!r} ({exc!r}); keeping it (fail open).",
                    file=sys.stderr,
                )
                kept.append(florist)

    await asyncio.gather(*(_judge(f) for f in ambiguous))
    return kept, dropped
