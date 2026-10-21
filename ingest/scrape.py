"""Apify wrapper — scrapes Google Maps florist listings via
`compass/crawler-google-places` and normalizes the raw fields we care about.

Search area: a circle around the geocoded city center, via the actor's
`customGeolocation` input (GeoJSON, coordinate order [lng, lat]) plus its
custom `radiusKm` field. Confirmed against the actor's live input schema
(2026-07-02, build 0.14.709):

    GET https://api.apify.com/v2/acts/compass~crawler-google-places/builds/<id>
    -> data.inputSchema.properties.customGeolocation:
       "title": "Custom search area (coordinate order must be:
                 [ longitude, latitude ])"
       "example": {"type": "Point", "coordinates": [-73.9857, 40.7484]}

The schema's own example is a bare Point (no radius shown), so the circle
form was cross-checked against the actor's published README
(https://apify.com/compass/crawler-google-places#custom-search-area), which
gives the exact circle shape:

    {"type": "Point", "coordinates": ["7.5503", "47.5590"], "radiusKm": 8}
    "For a circle, we can use the Point type with our custom parameter
    radiusKm."

We deliberately do NOT set `locationQuery` / `city` / `countryCode` —
the schema notes "Location settings always take priority over Geolocation",
so mixing them would silently ignore our radius circle.

Localized keywords: `searchStringsArray` takes the caller's localized keyword
list (see `keywords.py`) instead of a hard-coded `["florist"]`, and
`language` takes the caller's Google Maps language code instead of a
hard-coded `"en"`. The same underlying place can legitimately match more than
one keyword (e.g. both "florist" and "floristeria"), so results are deduped by
`placeId` below.

COST, AND WHY THIS FILE NOW TAKES A TOTAL CAP (2026-09-09)
----------------------------------------------------------
`maxCrawledPlacesPerSearch` is applied **per search string**, so N keywords at
L each can return up to N*L places. That made the caller's "limit" a number
that did not mean what it said, and the bill followed the keyword list rather
than the operator's intent: Spain has EIGHT keywords, so a run asked for
"limit 40" scraped 285 places and cost $1.14 — against a $6/month allowance.

Measured on three Spanish cities, 2026-09-09 (Madrid/Valencia/Sevilla):

    279 places -> $1.12   |   285 -> $1.14   |   285 -> $1.14

i.e. a flat **$4.00 per 1,000 places**, linear in places returned. Of those,
54-65% survived the relevance filter (mean ~58%), so ~26 places is ~15 shops.

So `max_places` is a TOTAL for the city, and the per-search cap is derived from
it. The operator picks the number they are billed for; the keyword count is an
implementation detail they should not have to know about. Recall is still
maximised WITHIN that budget — every keyword still runs, each just gets a
share.

Online-ordering (ecommerce) signal from Maps: verified against the same
build's dataset schema (`data.actorDefinition.storages.datasets.default`,
2026-07-02, build 0.14.709; a metadata-only call, no actor run):

- The actor has a dedicated `orderOnline` output field ("Online ordering
  options (pickup and delivery)"), but it is gated behind the paid
  `scrapeOrderOnline` input option ("🛵 Scrape order online widget data ($)"),
  and the option's own description scopes it to "the 'Order online' section
  of *restaurants* ... pickup and delivery providers (Uber Eats, DoorDash,
  etc.)". The legacy `orderBy` field it replaced was removed from the output
  entirely in the actor's 2026-05-18 breaking change. We deliberately do NOT
  enable `scrapeOrderOnline`: it costs extra per place and, per the actor's
  own docs, targets restaurant delivery-aggregator links, not florist
  ecommerce/cart presence.
- `additionalInfo` IS included in the base scrape (it's not gated behind the
  paid `scrapePlaceDetailPage` add-on — that add-on's field list doesn't
  mention it). It's a dict of category -> `[{label: bool}, ...]`, e.g.
  `{"Service options": [{"Online estimates": true}, {"Onsite services": true}]}`.
  When Google surfaces an explicit online-ordering-flavored label here (e.g.
  "Online ordering", "Order online", "Online estimates", "Online
  appointments"), we treat that as a strong positive signal, normalized into
  `maps_online_order`.

`maps_online_order` is `True` on a positive label match, else `None` — the
absence of a Maps-side label is not proof there's no online ordering, so we
store an honest null rather than `False`. It's consumed by `enrich.py`'s
ecommerce detection (combined with rule-based site signals) and is not a
persisted `florists` column itself; it shows up in `ecommerce_signals`.
"""

import os

from apify_client import ApifyClient

ACTOR_ID = "compass/crawler-google-places"

# The actor's `language` input validates against Google's legacy Maps
# language codes, which diverge from standard ISO 639-1 for a couple of
# languages — Hebrew is "iw", not "he" (2026-09-03: every IL ingest run was
# failing with the actor's 400 "must be equal to one of the allowed values"
# before this landed, because keywords.py/Claude correctly derives "he").
# KEEP IN STEP with ingest-worker/src/apify.ts::APIFY_LANGUAGE_OVERRIDES.
APIFY_LANGUAGE_OVERRIDES = {"he": "iw"}

ONLINE_ORDER_LABEL_KEYWORDS = (
    "online order",
    "order online",
    "online ordering",
    "online estimate",
    "online appointment",
    "online booking",
)


#: What one place costs, measured across three Apify runs on 2026-09-09.
#: Only used to explain the budget in logs — never to bill anything.
USD_PER_PLACE = 0.004


def per_search_cap(max_places: int, keyword_count: int) -> int:
    """Split a per-CITY place budget across the keywords that will run.

    `maxCrawledPlacesPerSearch` is per search string, so this is what turns
    "scrape at most N places in this city" into an actor input. Ceiling
    division, floored at 1: with more keywords than budget every keyword still
    gets one place rather than being silently switched off, which keeps a
    small budget from quietly becoming a single-keyword search.

    The real total can land UNDER the budget once duplicates are removed (the
    same shop matching several keywords is one place), and marginally over it
    only by the rounding on the last keyword — which the caller truncates.

    Mirrored in ingest-worker/src/apify.ts::perSearchCap; keep the two in step.
    """
    if keyword_count <= 0:
        return max(1, max_places)
    return max(1, -(-max_places // keyword_count))  # ceil without float error


def scrape_florists(
    center_lat: float,
    center_lng: float,
    radius_km: float,
    limit: int,
    keywords: list[str],
    language: str,
) -> tuple[list[dict], float | None]:
    """Run the Apify actor for the given localized `keywords` within a
    `radius_km` circle around (center_lat, center_lng), and return
    (normalized florists, apify_cost_usd). Florists are normalized,
    deduped-by-`place_id` dicts with the fields the brief calls out
    (place_id, name, address, lat/lng, rating, review_count, phone_maps,
    website_url) plus the internal `maps_online_order` signal.
    `apify_cost_usd` is the actor run's actual USD charge, or None if the
    actor didn't report it.

    Rows with no `place_id` are dropped — that field is the dedup key on
    the `florists` table and a row without it can't be upserted safely.
    """
    token = os.environ["APIFY_TOKEN"]
    client = ApifyClient(token)

    run_input = {
        "searchStringsArray": keywords,
        "customGeolocation": {
            "type": "Point",
            "coordinates": [center_lng, center_lat],
            "radiusKm": radius_km,
        },
        # `limit` is the budget for the CITY; the actor wants a per-search
        # number. Deriving it here is the whole point — the caller should not
        # have to know how many keywords this country happens to have in order
        # to predict what it will be billed.
        "maxCrawledPlacesPerSearch": per_search_cap(limit, len(keywords)),
        "language": APIFY_LANGUAGE_OVERRIDES.get(language, language),
    }
    run = client.actor(ACTOR_ID).call(run_input=run_input)
    if run is None:
        raise RuntimeError("Apify actor run did not complete (returned None)")
    # run.usage_total_usd is the actual USD charge for this run ("what you
    # actually pay", per the Apify API). None if the actor didn't report it.
    apify_cost_usd = getattr(run, "usage_total_usd", None)
    items = client.dataset(run.default_dataset_id).list_items().items

    normalized: list[dict] = []
    seen_place_ids: set[str] = set()
    for item in items:
        place_id = item.get("placeId")
        if not place_id or place_id in seen_place_ids:
            continue
        seen_place_ids.add(place_id)
        normalized.append(_normalize_item(item))
        # The per-search cap rounds UP, so N keywords can collectively return a
        # few more than the city budget. Truncating here makes `limit` mean
        # exactly what it says rather than "roughly this". It does not save
        # money — the actor has already crawled them — it keeps the number
        # honest, and stops one dense city quietly enriching 30 shops when the
        # operator asked for 25.
        if len(normalized) >= limit:
            break
    return normalized, apify_cost_usd


def _normalize_item(item: dict) -> dict:
    """Normalize one raw Apify item into the shape the rest of the pipeline uses.

    `category_name` (the actor's primary Maps category, e.g. "Florist") and
    `categories` (the full list Google assigned) are captured here for the
    relevance filter (see relevance.py) — transient scrape-time signals, not
    persisted `florists` columns, same treatment as `maps_online_order` below.
    """
    location = item.get("location") or {}
    return {
        "place_id": item.get("placeId"),
        "name": item.get("title"),
        "address": item.get("address"),
        "lat": location.get("lat"),
        "lng": location.get("lng"),
        "rating": item.get("totalScore"),
        "review_count": item.get("reviewsCount"),
        "phone_maps": item.get("phone"),
        "website_url": item.get("website"),
        "category_name": item.get("categoryName"),
        "categories": item.get("categories"),
        "maps_online_order": _extract_maps_online_order(item),
    }


def _extract_maps_online_order(item: dict) -> bool | None:
    """Best-effort Maps "online ordering" signal from `additionalInfo` — see
    the module docstring for what was checked and why. Returns True on a
    positive label match, else None (honest unknown, not False).
    """
    additional_info = item.get("additionalInfo") or {}
    for entries in additional_info.values():
        for entry in entries or []:
            for label, value in (entry or {}).items():
                if value and any(keyword in label.lower() for keyword in ONLINE_ORDER_LABEL_KEYWORDS):
                    return True
    return None
