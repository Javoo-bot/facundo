"""Supabase client factory + upsert helpers.

Ingest always uses the service-role key (bypasses RLS) — writes are
performed server-side by this CLI, never by the dashboard.
"""

import os
from datetime import datetime, timezone
from typing import Callable

from supabase import Client, create_client


def get_client() -> Client:
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


def soft_delete_city_florists(client: Client, city_id: str) -> int:
    """Soft-delete every currently-active florist of `city_id` (set deleted_at
    = now()). Returns the number of rows affected. Used by the delete-first
    re-run reset; rows are hidden, not removed, and any that reappear in the
    scrape are resurrected by the upsert (which sets deleted_at = null)."""
    resp = (
        client.table("florists")
        .update({"deleted_at": datetime.now(timezone.utc).isoformat()})
        .eq("city_id", city_id)
        .is_("deleted_at", "null")
        .execute()
    )
    return len(resp.data or [])


def fill_null_locales(client: Client, city_id: str, locale: str | None) -> int:
    """Set `locale` on this city's florists that don't have one yet, deriving it
    from the city's country (see locales.region_to_locale). Returns the number of
    rows updated.

    Never overwrites a florist's own choice — the `locale is null` guard means a
    self-service or staff-set locale always wins, so this is safe to re-run on
    every ingest. A no-op when the country doesn't imply a supported non-English
    language (`locale is None`): English florists stay null (null resolves to EN)."""
    if not locale:
        return 0
    resp = (
        client.table("florists")
        .update({"locale": locale})
        .eq("city_id", city_id)
        .is_("locale", "null")
        .is_("deleted_at", "null")
        .execute()
    )
    return len(resp.data or [])


def get_excluded_place_ids(client: Client, city_id: str) -> set[str]:
    """place_ids of this city's permanently-excluded florists (excluded_at set).
    The ingest drops these from the scrape so they're never (re-)persisted."""
    resp = (
        client.table("florists")
        .select("place_id")
        .eq("city_id", city_id)
        .not_.is_("excluded_at", "null")
        .execute()
    )
    return {row["place_id"] for row in (resp.data or [])}


def get_place_ids_with_advanced_lifecycle(client: Client, city_id: str) -> set[str]:
    """place_ids of this city's florists whose lifecycle_stage is past the
    default discovery stages ('found'/'targeted') — a human has already acted
    on them (contacted, engaged, onboarding, production) or explicitly marked
    them lost. The relevance filter (relevance.py) never re-judges these: a
    Claude false-negative on a re-scrape must not silently soft-delete a
    florist that's already carrying real outreach/order history."""
    resp = (
        client.table("florists")
        .select("place_id")
        .eq("city_id", city_id)
        .not_.in_("lifecycle_stage", ["found", "targeted"])
        .execute()
    )
    return {row["place_id"] for row in (resp.data or [])}


def get_or_create_city(
    client: Client,
    country: str,
    city: str,
    radius_km: float,
    geocode_fn: Callable[[], tuple[float, float, str | None]],
    region_hint: str | None = None,
) -> tuple[str, bool]:
    """Return (city_id, was_created).

    `geocode_fn` (Nominatim) is always called for a brand-new city, since
    center_lat/center_lng have to come from somewhere. For an *existing*
    city it's normally skipped (`cities` acts as a cache) — except when the
    row has no `region` yet, in which case it's called once more just to
    backfill that field, so a plain re-run of ingest fills in a missing
    region without re-geocoding cities that already have one.

    `radius_km` is the radius used for *this* ingest run; it's persisted on
    the city row (created or existing) so the dashboard can show/draw the
    search area actually used most recently.

    `region_hint` (e.g. "Balears") disambiguates same-named cities in
    different regions — see geocode.py. When given (non-empty after
    `.strip()`), the cache-first behavior above is bypassed entirely:
    `geocode_fn` is always called fresh (Nominatim calls are rate-limited,
    not metered, so re-geocoding on every hinted call is a deliberate, cheap
    trade favoring correctness over that cache hit — it also means a
    previously wrong-region-cached name is never silently reused just
    because SOME row exists for that (country, city)). The city is then
    looked up/inserted keyed on (country, city, resolved_region) — using the
    region Nominatim itself just returned, not the hint string verbatim,
    since they may not match (hint "Balears" vs Nominatim's own "Illes
    Balears") — so repeated hinted calls for the same real place converge
    onto the same cached row over time.
    """
    region_hint = (region_hint or "").strip()

    if not region_hint:
        existing = (
            client.table("cities")
            .select("id, region")
            .eq("country", country)
            .eq("city", city)
            .limit(1)
            .execute()
        )
        if existing.data:
            city_id = existing.data[0]["id"]
            update = {"radius_km": radius_km}
            if not existing.data[0].get("region"):
                _, _, region = geocode_fn()
                update["region"] = region or ""
            client.table("cities").update(update).eq("id", city_id).execute()
            return city_id, False

        lat, lng, region = geocode_fn()
        inserted = (
            client.table("cities")
            .insert(
                {
                    "country": country,
                    "city": city,
                    "center_lat": lat,
                    "center_lng": lng,
                    "radius_km": radius_km,
                    "region": region or "",
                }
            )
            .execute()
        )
        return inserted.data[0]["id"], True

    lat, lng, region = geocode_fn()
    resolved_region = region or ""
    existing = (
        client.table("cities")
        .select("id")
        .eq("country", country)
        .eq("city", city)
        .eq("region", resolved_region)
        .limit(1)
        .execute()
    )
    if existing.data:
        city_id = existing.data[0]["id"]
        client.table("cities").update({"radius_km": radius_km}).eq("id", city_id).execute()
        return city_id, False

    inserted = (
        client.table("cities")
        .insert(
            {
                "country": country,
                "city": city,
                "center_lat": lat,
                "center_lng": lng,
                "radius_km": radius_km,
                "region": resolved_region,
            }
        )
        .execute()
    )
    return inserted.data[0]["id"], True


def get_city_center(client: Client, city_id: str) -> tuple[float, float]:
    row = (
        client.table("cities")
        .select("center_lat, center_lng")
        .eq("id", city_id)
        .limit(1)
        .execute()
        .data[0]
    )
    return row["center_lat"], row["center_lng"]


def upsert_florists(client: Client, rows: list[dict]) -> None:
    """Upsert florist rows keyed on (city_id, place_id) — idempotent re-runs."""
    if not rows:
        return
    client.table("florists").upsert(rows, on_conflict="city_id,place_id").execute()


# --- Florist networks (see networks.py for the why) --------------------------


def sync_network_registry(client: Client) -> dict[str, str]:
    """Ensure every seeded network exists, and return {domain: network_id}.

    Idempotent — upserts on the unique `domain`, so re-running ingest neither
    duplicates a network nor overwrites a kind a human has corrected in the
    dashboard. Returns the FULL registry (seeded rows plus any added by hand),
    so a network curated in the DB but absent from SEED_NETWORKS still links
    florists at ingest time.
    """
    from networks import SEED_NETWORKS

    rows = [
        {
            "name": n.name,
            "domain": n.domain,
            "kind": n.kind,
            "contact_email": n.contact_email,
            "notes": n.notes,
        }
        for n in SEED_NETWORKS
    ]
    if rows:
        # `ignore_duplicates` so a hand-corrected kind/name is never clobbered
        # by the seed's original guess — the seed is a starting point, the DB
        # row is the truth once someone has looked at it.
        client.table("florist_networks").upsert(
            rows, on_conflict="domain", ignore_duplicates=True
        ).execute()

    data = client.table("florist_networks").select("id, domain").execute().data or []
    return {row["domain"]: row["id"] for row in data}


def sweep_shared_emails(client: Client) -> int:
    """Recompute `florists.email_shared_count` across ALL florists.

    An address shared by more than one shop identifies none of them, so the
    offer path stops using it (dashboard/lib/offerChannels.ts::emailSkipReason).

    Deliberately global rather than per-city: two shops sharing an address are
    very often in DIFFERENT cities (a national network), so a city-scoped sweep
    would score both as unique and miss exactly the case that matters.

    Returns the number of florists whose count changed.
    """
    from networks import shared_email_counts

    rows: list[dict] = []
    page = 0
    while True:
        batch = (
            client.table("florists")
            .select("id, email, email_shared_count")
            .range(page * 1000, page * 1000 + 999)
            .execute()
            .data
            or []
        )
        rows.extend(batch)
        if len(batch) < 1000:
            break
        page += 1

    counts = shared_email_counts(rows)
    changed = 0
    for row in rows:
        email = (row.get("email") or "").strip().lower()
        want = counts.get(email, 1) if email else 1
        if row.get("email_shared_count") != want:
            client.table("florists").update({"email_shared_count": want}).eq("id", row["id"]).execute()
            changed += 1
    return changed
