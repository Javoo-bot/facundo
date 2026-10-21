"""Facundo POC ingest CLI.

    python main.py --country US --city Boston [--limit 100] [--radius 10.0]
                    [--keywords "florist,floristeria"] [--language es]

Order of operations: geocode city center (cached) -> resolve localized search
keywords (given via --keywords, or derived/cached via keywords.py) -> scrape
Apify within a radius-km circle around that center -> compute distance from
center -> enrich concurrently -> draft outreach emails -> upsert to Supabase.
Idempotent: re-running the same city updates rather than duplicates (upsert
keyed on city_id + place_id).
"""

import asyncio
import os
import sys

import click
from llm_client import get_llm_client
from dotenv import load_dotenv
from geopy.distance import geodesic
from supabase import Client

from db import get_city_center, get_client, get_excluded_place_ids, get_or_create_city, get_place_ids_with_advanced_lifecycle, fill_null_locales, soft_delete_city_florists, sweep_shared_emails, sync_network_registry, upsert_florists
from networks import match_network
from locales import region_to_locale
from shop_country import phone_region_for
import enrich
from enrich import enrich_all
from geocode import geocode_city_center
from jobs import create_job, finish_job, update_job_progress
from keywords import get_keywords_for_country, normalize_country, upsert_keywords_for_country
from phones import country_to_region, normalize_phone
from relevance import filter_florists_by_relevance
from scrape import scrape_florists
from usage import UsageTracker

REQUIRED_ENV_VARS = ["APIFY_TOKEN", "OPENROUTER_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]

load_dotenv()


@click.command()
@click.option("--country", required=True, help='Country name, e.g. "US"')
@click.option("--city", required=True, help='City name, e.g. "Boston"')
@click.option(
    "--limit",
    default=25,
    show_default=True,
    help=(
        "Max places to scrape for this CITY, across all keywords. Apify bills "
        "per place (~$4/1000), and roughly 58%% survive the relevance filter, "
        "so 25 costs ~$0.10 and yields ~15 florists. This used to be a "
        "PER-KEYWORD cap, which made the bill follow the country's keyword "
        "count rather than this number."
    ),
)
@click.option(
    "--radius",
    "radius_km",
    default=10.0,
    show_default=True,
    type=float,
    help="Search radius in km around the geocoded city center",
)
@click.option(
    "--keywords",
    default=None,
    help=(
        'Comma-separated localized search keywords, e.g. "florist,floristeria". '
        "If given, these are used as-is AND upserted into the country_keywords "
        "cache (requires --language). If omitted, keywords are derived (or read "
        "from cache) via keywords.py for --country."
    ),
)
@click.option(
    "--language",
    default=None,
    help="Google Maps language code for the search (e.g. 'es'). Required with --keywords.",
)
@click.option(
    "--job-id",
    default=None,
    help="UUID minted by the dashboard to track this run's progress in ingest_jobs. Omit for local/manual runs.",
)
@click.option(
    "--reset-existing",
    is_flag=True,
    default=False,
    help="Soft-delete the city's existing florists before scraping (they resurrect if they reappear).",
)
@click.option(
    "--region",
    "region_hint",
    default=None,
    help=(
        "Administrative region/state hint (e.g. 'Balears'), to disambiguate a "
        "same-named city — see ingest/geocode.py."
    ),
)
@click.option(
    "--near-lat",
    "near_lat",
    default=None,
    type=float,
    help="Reference latitude to sanity-check the geocoded city center against (see ingest/geocode.py).",
)
@click.option(
    "--near-lng",
    "near_lng",
    default=None,
    type=float,
    help="Reference longitude paired with --near-lat.",
)
def main(
    country: str,
    city: str,
    limit: int,
    radius_km: float,
    keywords: str | None,
    language: str | None,
    job_id: str | None,
    reset_existing: bool,
    region_hint: str | None,
    near_lat: float | None,
    near_lng: float | None,
) -> None:
    missing = [name for name in REQUIRED_ENV_VARS if not os.environ.get(name)]
    if missing:
        click.echo(f"Missing required environment variables: {', '.join(missing)}", err=True)
        sys.exit(1)

    if keywords and not language:
        click.echo("--language is required when --keywords is given.", err=True)
        sys.exit(1)

    # Normalize the city name so casing variants ("sitges"/"Sitges"/"SITGES")
    # collapse to one row — the (country, city) unique key is case-sensitive,
    # so without this a re-typed city creates a duplicate city + duplicate data.
    city = city.strip().title()
    country = normalize_country(country)

    db = get_client()
    claude = get_llm_client()
    tracker = UsageTracker()

    if job_id:
        # Best-effort: makes a running job visible in the dashboard as early
        # as possible, even during the long geocode/scrape steps below.
        # keywords/language aren't resolved yet at this point.
        create_job(db, job_id, country, city, radius_km, limit, keywords=None, language=None)

    apify_cost_usd = None
    florists = []
    try:
        _echo(f"[1/8] Geocoding {city}, {country}...", job_id, db)
        near = (near_lat, near_lng) if near_lat is not None and near_lng is not None else None
        city_id, created = get_or_create_city(
            db,
            country,
            city,
            radius_km,
            lambda: geocode_city_center(country, city, region_hint=region_hint, near=near),
            region_hint=region_hint,
        )
        center = get_city_center(db, city_id)
        _echo(f"      city_id={city_id} center={center} ({'geocoded' if created else 'cached'})", job_id, db)

        phone_region = country_to_region(country)
        _echo(
            "      Phone normalization region: "
            + (phone_region or "unresolved — numbers already starting with a country code will still parse"),
            job_id,
            db,
        )
        # Reuse the resolved region to derive the florist locale for this country
        # (ES → 'es', FR → 'fr', …; English/unmapped → None, left unset). Applied
        # as a null-only fill after the florists land, so a florist's own language
        # choice is never overwritten. See fill_null_locales below.
        florist_locale = region_to_locale(phone_region)

        if reset_existing:
            n_deleted = soft_delete_city_florists(db, city_id)
            _echo(
                f"      Reset: soft-deleted {n_deleted} existing florist(s) before scraping "
                "(returning florists will resurrect).",
                job_id,
                db,
            )

        if keywords:
            keyword_list = [k.strip() for k in keywords.split(",") if k.strip()]
            if not keyword_list:
                click.echo("--keywords was given but contained no non-empty terms.", err=True)
                # sys.exit() raises SystemExit, which the `except Exception` below
                # does not catch — finish the job explicitly here so it doesn't
                # stay stuck at status='running' forever in this validation path.
                if job_id:
                    finish_job(
                        db, job_id, status="failed", error="--keywords was given but contained no non-empty terms."
                    )
                sys.exit(1)
            _echo(f"[2/8] Using provided keywords {keyword_list} (language={language})...", job_id, db)
            upsert_keywords_for_country(db, country, keyword_list, language)
        else:
            _echo(f"[2/8] Deriving localized search keywords for {country} (cache-first)...", job_id, db)
            keyword_list, language = get_keywords_for_country(db, country)
            _echo(f"      keywords={keyword_list} language={language}", job_id, db)

        _echo(
            f"[3/8] Scraping Apify for florists within {radius_km}km of {city}, {country} "
            f"center (limit={limit} per keyword)...",
            job_id,
            db,
        )
        florists, apify_cost_usd = scrape_florists(
            center[0], center[1], radius_km, limit, keyword_list, language
        )
        _echo(f"      Found {len(florists)} florist(s) (deduped by place_id).", job_id, db)

        excluded = get_excluded_place_ids(db, city_id)
        if excluded:
            before = len(florists)
            florists = [f for f in florists if f["place_id"] not in excluded]
            skipped = before - len(florists)
            if skipped:
                _echo(f"      Skipped {skipped} excluded florist(s) (permanent denylist).", job_id, db)

        vouched_place_ids = get_place_ids_with_advanced_lifecycle(db, city_id)
        _echo(f"[4/8] Filtering {len(florists)} result(s) for florist relevance...", job_id, db)
        florists, dropped = asyncio.run(
            filter_florists_by_relevance(florists, keyword_list, claude, tracker, vouched_place_ids)
        )
        if dropped:
            examples = "; ".join(f["_relevance_reason"] for f in dropped[:10])
            more = f" (+{len(dropped) - 10} more)" if len(dropped) > 10 else ""
            _echo(f"      Filtered {len(dropped)} place(s) that didn't look like florists.", job_id, db)
            _echo(f"      e.g.: {examples}{more}", job_id, db)
        else:
            _echo("      Nothing filtered — every result looked like a florist.", job_id, db)

        _echo("[5/8] Computing distance from city center...", job_id, db)
        for florist in florists:
            lat, lng = florist.get("lat"), florist.get("lng")
            florist["distance_km_from_center"] = (
                geodesic(center, (lat, lng)).km if lat is not None and lng is not None else None
            )

        _echo(
            f"[6/8] Persisting {len(florists)} scraped florist(s) as bare rows "
            "(enrichment to follow)...",
            job_id,
            db,
        )
        upsert_florists(db, [_build_bare_row(f, city_id, phone_region) for f in florists])
        _echo(f"      City is now queryable with {len(florists)} florist(s).", job_id, db)

        # Default each florist's UI/email language from the city's country, filling
        # only those without a locale yet (a manual choice always wins). No-op for
        # English/unmapped countries — those florists stay null and resolve to EN.
        if florist_locale:
            n_localed = fill_null_locales(db, city_id, florist_locale)
            _echo(f"      Set locale '{florist_locale}' on {n_localed} florist(s) with no language set.", job_id, db)

        _echo(
            f"[7/8] Enriching + drafting + updating {len(florists)} florist(s) "
            f"(max {enrich.MAX_CONCURRENT_ENRICHMENTS} concurrent, "
            f"max {enrich.MAX_CONCURRENT_RENDERS} headless renders)...",
            job_id,
            db,
        )

        # Network registry, read once for the whole run. Maps a registrable
        # domain to its florist_networks id, so a florist whose "website" is
        # actually its profile page on a network/franchise/directory site gets
        # linked — which is what tells the offer path that the email scraped
        # from that page is the head office's, not this shop's. See
        # networks.py for the incident this came from.
        network_ids = sync_network_registry(db)

        async def finalize(florist: dict, enrichment: dict) -> None:
            # Merge enrichment and upsert this florist's FULL row so each
            # florist updates in place as it finishes. Drafting is no longer
            # done here — it happens on-demand from the dashboard
            # (POST /api/florists/draft-email); see the Phase 0 spec. The
            # blocking Supabase call goes through asyncio.to_thread so it
            # doesn't stall the event loop.
            florist.update(enrichment)
            await asyncio.to_thread(
                upsert_florists, db, [_build_row(florist, city_id, phone_region, network_ids)]
            )

        asyncio.run(enrich_all(florists, claude, tracker, on_done=finalize))

        # Shared-address sweep. A florist can only be compared against every
        # OTHER florist once its own row is written, so this runs after the
        # batch rather than inside `finalize`. Global by design (see
        # db.sweep_shared_emails) — the shops sharing an address are usually in
        # different cities.
        n_shared = sweep_shared_emails(db)
        n_networked = sum(1 for f in florists if f.get("network_id"))

        with_website = sum(1 for f in florists if f.get("has_website"))
        with_email = sum(1 for f in florists if f.get("email"))
        _echo(
            f"[8/8] Done. {len(florists)} florist(s) for {city}, {country}: "
            f"{with_website} with website, {with_email} with email "
            f"({n_networked} on a known network's site — their email is the network's, "
            f"not the shop's). Shared-address sweep updated {n_shared} florist(s).",
            job_id,
            db,
        )
    except Exception as exc:
        if job_id:
            finish_job(
                db, job_id, status="failed", error=str(exc)[:500],
                usage=tracker, apify_cost_usd=apify_cost_usd, florist_count=len(florists),
            )
        raise
    else:
        if job_id:
            finish_job(
                db, job_id, status="succeeded",
                usage=tracker, apify_cost_usd=apify_cost_usd, florist_count=len(florists),
            )


def _echo(line: str, job_id: str | None, db: Client) -> None:
    click.echo(line)
    if job_id:
        update_job_progress(db, job_id, line)


def _build_bare_row(florist: dict, city_id: str, phone_region: str | None) -> dict:
    """Maps-only row persisted right after scraping, so the city is queryable
    before enrichment finishes. Enrichment columns are left null/default;
    deleted_at=None resurrects a returning-after-reset florist. The full row
    (`_build_row`) overwrites this as each florist finishes enriching."""
    return {
        "city_id": city_id,
        "place_id": florist["place_id"],
        "name": florist["name"],
        "address": florist.get("address"),
        "lat": florist.get("lat"),
        "lng": florist.get("lng"),
        "rating": florist.get("rating"),
        "review_count": florist.get("review_count"),
        "distance_km_from_center": florist.get("distance_km_from_center"),
        "phone_maps": normalize_phone(florist.get("phone_maps"), phone_region_for(florist.get("address"), phone_region)),
        "website_url": florist.get("website_url"),
        "has_website": bool(florist.get("website_url")),
        # Google's own category — the relevance filter's free rule reads this
        # (relevance.py::category_matches_florist). Persisted so an existing
        # florist can be re-judged without re-scraping the city.
        "category_name": florist.get("category_name"),
        "categories": florist.get("categories"),
        "deleted_at": None,
    }


def _build_row(
    florist: dict,
    city_id: str,
    phone_region: str | None,
    network_ids: dict[str, str] | None = None,
) -> dict:
    # Is this florist's "website" actually a network/franchise/directory site?
    # If so its scraped `email` is that organisation's, not this shop's. We
    # still STORE the address (it's true of the page we found, and staff need
    # to see what we picked up) — the link is what stops it being used as a
    # recipient. Defaults to None when no registry was passed, so callers that
    # predate this keep their old behaviour.
    network_id = None
    if network_ids:
        domain = match_network(florist.get("website_url"), network_ids)
        network_id = network_ids.get(domain) if domain else None
    florist["network_id"] = network_id
    return {
        "city_id": city_id,
        "place_id": florist["place_id"],
        "name": florist["name"],
        "address": florist.get("address"),
        "lat": florist.get("lat"),
        "lng": florist.get("lng"),
        "rating": florist.get("rating"),
        "review_count": florist.get("review_count"),
        "distance_km_from_center": florist.get("distance_km_from_center"),
        "phone_maps": normalize_phone(florist.get("phone_maps"), phone_region_for(florist.get("address"), phone_region)),
        "website_url": florist.get("website_url"),
        "has_website": florist.get("has_website", False),
        # See _build_bare_row — kept on the full row too so a florist that
        # finishes enrichment doesn't lose the category the bare row stored.
        "category_name": florist.get("category_name"),
        "categories": florist.get("categories"),
        "is_ecommerce": florist.get("is_ecommerce"),
        "ecommerce_signals": florist.get("ecommerce_signals"),
        "email": florist.get("email"),
        "network_id": network_id,
        "phone_web": normalize_phone(florist.get("phone_web"), phone_region_for(florist.get("address"), phone_region)),
        "owner_name": florist.get("owner_name"),
        "shop_highlight": florist.get("shop_highlight"),
        "enrichment_notes": florist.get("enrichment_notes"),
        # drafted_email is deliberately omitted: it's written on-demand from
        # the dashboard (POST /api/florists/draft-email). Upsert-on-conflict
        # updates only the keys present here, so re-ingesting a city preserves
        # any existing draft rather than nulling it.
        "deleted_at": None,
    }


if __name__ == "__main__":
    main()
