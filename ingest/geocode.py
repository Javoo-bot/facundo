"""City-center geocoding via Nominatim (OpenStreetMap).

Nominatim's usage policy requires a descriptive custom User-Agent and caps
requests at 1/sec. Since `cities` acts as a cache (unique on
country+city+region), callers should skip geocoding entirely when the row
already exists — this module only performs the actual lookup.
"""

import time

from geopy.distance import geodesic
from geopy.geocoders import Nominatim

USER_AGENT = "facundo-poc-ingest/0.1 (contact: staff@fc.example.com)"
MIN_REQUEST_INTERVAL_SECONDS = 1.0

# Generous on purpose: city-center-vs-exact-address drift can legitimately be
# tens of km, so this only needs to catch "wrong city entirely" mistakes like
# the 900km San Carlos (Balears vs Castilla y León) mix-up that motivated it.
MAX_GEOCODE_DRIFT_KM = 150

_last_request_at: float = 0.0


def _throttle() -> None:
    """Enforce Nominatim's <=1 request/sec usage policy."""
    global _last_request_at
    elapsed = time.monotonic() - _last_request_at
    if elapsed < MIN_REQUEST_INTERVAL_SECONDS:
        time.sleep(MIN_REQUEST_INTERVAL_SECONDS - elapsed)
    _last_request_at = time.monotonic()


_REGION_ADDRESS_KEYS = ("state", "province", "region", "state_district")


class GeocodeMismatchError(ValueError):
    """Raised when the nearest geocode candidate is still implausibly far
    from the given reference point (`near`) — see MAX_GEOCODE_DRIFT_KM.

    A ValueError subclass so it's caught by any existing `except ValueError`/
    `except Exception` handling a plain failed-geocode ValueError already
    goes through (e.g. main.py's job-failure path)."""


def _extract_region(location) -> str | None:
    address = location.raw.get("address", {})
    return next((address[key] for key in _REGION_ADDRESS_KEYS if address.get(key)), None)


def _reverse_geocode(geolocator: Nominatim, near: tuple[float, float]):
    """Reverse-geocode `near` — a village/suburb-level lookup (zoom=14) around
    a point Nominatim's free-text search couldn't resolve at all. See
    ingest-worker/src/geocode.ts::reverseGeocode for the 2026-09-04
    "SAINT BARTHOLOMY, CH" case this exists for: a real order's delivery
    address geocoded to a real point (near Saint-Barthélemy, Vaud), but the
    order's own `city` string reached us mangled (missing the accent AND
    misspelled), so the forward query matched nothing even though we're
    already standing right next to the real place. Returns None (never
    raises) on any failure — the caller's existing "could not geocode" error
    is a perfectly good fallback of the fallback. KEEP IN STEP.
    """
    try:
        _throttle()
        return geolocator.reverse(near, exactly_one=True, addressdetails=True, zoom=14, timeout=10)
    except Exception:
        return None


def geocode_city_center(
    country: str,
    city: str,
    region_hint: str | None = None,
    near: tuple[float, float] | None = None,
) -> tuple[float, float, str | None]:
    """Look up the (lat, lng) center of a city, plus its administrative region.

    The region is read from Nominatim's address details, preferring (in
    order) `state`, `province`, `region`, then `state_district`; it's `None`
    when Nominatim's response has none of those.

    `region_hint` (e.g. "Balears"), when given non-empty, is appended to the
    query string to disambiguate same-named cities in different regions.

    `near` (lat, lng), when given, requests multiple candidates from Nominatim
    and picks whichever is closest to `near` — rather than blindly trusting
    Nominatim's top-ranked result — since region-qualifying the query alone
    is not always enough to land on the right place. If even the closest
    candidate is farther than MAX_GEOCODE_DRIFT_KM from `near`, raises
    GeocodeMismatchError rather than silently caching a wrong location.

    When `near` is omitted, behavior is unchanged from before this
    disambiguation feature existed: a single top-ranked result, no distance
    filtering — this is the only reference-point-free option, used by plain
    manual CLI runs with nothing to check the result against.

    Raises ValueError if Nominatim has no result for the query at all.
    """
    geolocator = Nominatim(user_agent=USER_AGENT)
    region_hint = (region_hint or "").strip()
    query = f"{city}, {region_hint}, {country}" if region_hint else f"{city}, {country}"

    if near is None:
        _throttle()
        location = geolocator.geocode(query, addressdetails=True, timeout=10)
        if location is None:
            raise ValueError(f"Nominatim could not geocode '{query}'")
        return location.latitude, location.longitude, _extract_region(location)

    _throttle()
    candidates = geolocator.geocode(query, exactly_one=False, limit=8, addressdetails=True, timeout=10)
    if not candidates:
        reversed_location = _reverse_geocode(geolocator, near)
        if reversed_location is not None:
            return reversed_location.latitude, reversed_location.longitude, _extract_region(reversed_location)
        raise ValueError(f"Nominatim could not geocode '{query}'")

    best = min(candidates, key=lambda loc: geodesic(near, (loc.latitude, loc.longitude)).km)
    drift_km = geodesic(near, (best.latitude, best.longitude)).km
    if drift_km > MAX_GEOCODE_DRIFT_KM:
        region = _extract_region(best)
        raise GeocodeMismatchError(
            f"Nominatim query '{query}' resolved to ({best.latitude}, {best.longitude}) "
            f"region={region!r}, which is {drift_km:.1f}km from the expected point {near} "
            f"— farther than the {MAX_GEOCODE_DRIFT_KM}km drift tolerance. This usually means "
            "the query matched the wrong same-named place; refine --region or --near-lat/--near-lng."
        )
    return best.latitude, best.longitude, _extract_region(best)
