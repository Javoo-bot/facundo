"""Sanity assertions for region-disambiguated geocoding (2026-08-25).
Run: uv run python test_geocode.py

Covers the San Carlos (Balears vs Castilla y Leon, ~900km apart) bug fix:
geocode_city_center now takes an optional region_hint (query disambiguation)
and near point (candidate sanity-check against a reference point), and
get_or_create_city widens its cache key to (country, city, region) only when
a region_hint is actually given, re-geocoding fresh every hinted call.
"""
from unittest.mock import patch

import geocode
from db import get_or_create_city
from geocode import GeocodeMismatchError, geocode_city_center


# --- fakes -------------------------------------------------------------------


class FakeLocation:
    def __init__(self, latitude, longitude, region=None):
        self.latitude = latitude
        self.longitude = longitude
        self.raw = {"address": {"state": region}} if region else {"address": {}}


class FakeGeolocator:
    """Stands in for geopy's Nominatim. `responses` maps the built query
    string to either a single FakeLocation (exactly_one path) or a list of
    them (exactly_one=False path); records every call for assertions.
    `reverse_response`, when given, is what `.reverse()` returns (a
    FakeLocation, or None to simulate Nominatim finding nothing there
    either) — omitting it entirely simulates a geolocator with no reverse
    support at all, which the real fallback must also tolerate."""

    def __init__(self, responses, reverse_response="_unset"):
        self.responses = responses
        self.calls = []
        self.reverse_calls = []
        self._reverse_response = reverse_response

    def geocode(self, query, **kwargs):
        self.calls.append({"query": query, **kwargs})
        return self.responses.get(query)

    def reverse(self, near, **kwargs):
        if self._reverse_response == "_unset":
            raise AttributeError("this fake has no reverse configured")
        self.reverse_calls.append({"near": near, **kwargs})
        return self._reverse_response


def _patched_nominatim(fake):
    return patch("geocode.Nominatim", return_value=fake)


class FakeResult:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    """Minimal stand-in for the postgrest-py chained builder, covering only
    the exact chain shapes db.py::get_or_create_city actually calls:
    select().eq()...limit().execute() / insert().execute() /
    update().eq().execute()."""

    def __init__(self, table, op, payload=None):
        self.table = table
        self.op = op
        self.payload = payload
        self.filters = {}
        self.limit_n = None

    def eq(self, col, val):
        self.filters[col] = val
        return self

    def limit(self, n):
        self.limit_n = n
        return self

    def execute(self):
        if self.op == "select":
            rows = [r for r in self.table.rows if all(r.get(k) == v for k, v in self.filters.items())]
            if self.limit_n is not None:
                rows = rows[: self.limit_n]
            return FakeResult(rows)
        if self.op == "insert":
            row = {"id": f"city-{len(self.table.rows) + 1}", **self.payload}
            self.table.rows.append(row)
            return FakeResult([row])
        if self.op == "update":
            updated = []
            for r in self.table.rows:
                if all(r.get(k) == v for k, v in self.filters.items()):
                    r.update(self.payload)
                    updated.append(r)
            return FakeResult(updated)
        raise AssertionError(f"unexpected op {self.op}")


class FakeCitiesTable:
    def __init__(self):
        self.rows = []

    def select(self, _cols):
        return FakeQuery(self, "select")

    def insert(self, payload):
        return FakeQuery(self, "insert", payload)

    def update(self, payload):
        return FakeQuery(self, "update", payload)


class FakeClient:
    def __init__(self):
        self.cities = FakeCitiesTable()

    def table(self, name):
        assert name == "cities"
        return self.cities


# --- geocode_city_center: query construction ---------------------------------


def test_query_has_no_region_when_no_hint_given():
    fake = FakeGeolocator({"Boston, US": FakeLocation(42.3, -71.0, "Massachusetts")})
    with _patched_nominatim(fake):
        lat, lng, region = geocode_city_center("US", "Boston")
    assert (lat, lng, region) == (42.3, -71.0, "Massachusetts")
    assert fake.calls[0]["query"] == "Boston, US"


def test_query_includes_region_hint_when_given():
    fake = FakeGeolocator({"Sitges, Catalunya, ES": FakeLocation(41.23, 1.80, "Catalunya")})
    with _patched_nominatim(fake):
        geocode_city_center("ES", "Sitges", region_hint="Catalunya")
    assert fake.calls[0]["query"] == "Sitges, Catalunya, ES"


def test_blank_region_hint_is_treated_as_no_hint():
    fake = FakeGeolocator({"Boston, US": FakeLocation(42.3, -71.0)})
    with _patched_nominatim(fake):
        geocode_city_center("US", "Boston", region_hint="   ")
    assert fake.calls[0]["query"] == "Boston, US"


# --- geocode_city_center: near-point disambiguation ---------------------------


def test_no_near_point_keeps_single_result_call_shape():
    fake = FakeGeolocator({"Boston, US": FakeLocation(42.3, -71.0, "Massachusetts")})
    with _patched_nominatim(fake):
        geocode_city_center("US", "Boston")
    call = fake.calls[0]
    # Unchanged from pre-fix behavior: no exactly_one=False, no limit override.
    assert "exactly_one" not in call
    assert "limit" not in call


def test_near_point_picks_nearest_candidate_not_top_ranked():
    # Nominatim's own ranking puts the WRONG (far) village first; the RIGHT
    # (near) one is #6 — mirrors the real San Carlos investigation.
    near = (39.033, 1.564)  # San Carlos, Balears
    wrong = FakeLocation(41.65, -4.72, "Castilla y Leon")  # ~900km away, ranked #1
    right = FakeLocation(39.03, 1.57, "Illes Balears")  # ~0.8km away, ranked #6
    query = "San Carlos, Balears, ES"
    fake = FakeGeolocator({query: [wrong, wrong, wrong, wrong, wrong, right, wrong, wrong]})
    with _patched_nominatim(fake):
        lat, lng, region = geocode_city_center("ES", "San Carlos", region_hint="Balears", near=near)
    assert (lat, lng) == (39.03, 1.57)
    assert region == "Illes Balears"
    call = fake.calls[0]
    assert call["exactly_one"] is False
    assert call["limit"] == 8


def test_near_point_raises_mismatch_when_nearest_is_still_too_far():
    near = (39.033, 1.564)  # San Carlos, Balears
    far = FakeLocation(41.65, -4.72, "Castilla y Leon")  # ~900km away — no candidate is close
    query = "San Carlos, Balears, ES"
    fake = FakeGeolocator({query: [far, far]})
    with _patched_nominatim(fake):
        try:
            geocode_city_center("ES", "San Carlos", region_hint="Balears", near=near)
            raise AssertionError("expected GeocodeMismatchError")
        except GeocodeMismatchError as exc:
            assert isinstance(exc, ValueError)
            assert "San Carlos, Balears, ES" in str(exc)
            assert "150" in str(exc)


def test_near_point_with_no_results_raises_plain_valueerror_not_mismatch():
    near = (39.033, 1.564)
    query = "Nowhere, Balears, ES"
    fake = FakeGeolocator({query: []})
    with _patched_nominatim(fake):
        try:
            geocode_city_center("ES", "Nowhere", region_hint="Balears", near=near)
            raise AssertionError("expected ValueError")
        except GeocodeMismatchError:
            raise AssertionError("empty result set should raise plain ValueError, not GeocodeMismatchError")
        except ValueError:
            pass


# --- geocode_city_center: reverse-geocode fallback (2026-09-04) --------------
# The real "SAINT BARTHOLOMY, CH" case: a Shopify order's delivery address
# geocoded fine (that's `near`), but its `city` string reached the ingest
# mangled ("SAINT BARTHOLOMY" vs the real "Saint-Barthélemy"), so the forward
# free-text search matched nothing even though we're already standing right
# next to the real place. KEEP IN STEP with
# ingest-worker/test/geocode.test.ts.


def test_forward_miss_falls_back_to_reverse_geocode_off_near():
    near = (46.6342834, 6.5942567)
    query = "SAINT BARTHOLOMY, CH"
    reversed_location = FakeLocation(46.63516, 6.5921502, "Vaud")
    fake = FakeGeolocator({query: []}, reverse_response=reversed_location)
    with _patched_nominatim(fake):
        lat, lng, region = geocode_city_center("CH", "SAINT BARTHOLOMY", near=near)
    assert (lat, lng, region) == (46.63516, 6.5921502, "Vaud")
    assert fake.reverse_calls[0]["near"] == near


def test_forward_and_reverse_both_missing_still_raises_plain_valueerror():
    near = (39.033, 1.564)
    query = "Nowhere, ES"
    fake = FakeGeolocator({query: []}, reverse_response=None)
    with _patched_nominatim(fake):
        try:
            geocode_city_center("ES", "Nowhere", near=near)
            raise AssertionError("expected ValueError")
        except GeocodeMismatchError:
            raise AssertionError("should raise plain ValueError, not GeocodeMismatchError")
        except ValueError:
            pass


def test_reverse_geocode_errors_are_swallowed_same_as_a_miss():
    # A geolocator with no working .reverse() at all (AttributeError on call)
    # must degrade to the same plain ValueError, not propagate the AttributeError.
    near = (39.033, 1.564)
    query = "Nowhere, ES"
    fake = FakeGeolocator({query: []})  # reverse_response left "_unset"
    with _patched_nominatim(fake):
        try:
            geocode_city_center("ES", "Nowhere", near=near)
            raise AssertionError("expected ValueError")
        except GeocodeMismatchError:
            raise AssertionError("should raise plain ValueError, not GeocodeMismatchError")
        except ValueError:
            pass


# --- get_or_create_city: no-hint path (today's behavior, unchanged) ----------


def test_no_hint_creates_then_reuses_cached_row_without_regeocoding():
    calls = {"n": 0}

    def geocode_fn():
        calls["n"] += 1
        return (42.3, -71.0, "Massachusetts")

    client = FakeClient()
    city_id_1, created_1 = get_or_create_city(client, "US", "Boston", 10.0, geocode_fn)
    city_id_2, created_2 = get_or_create_city(client, "US", "Boston", 12.0, geocode_fn)

    assert created_1 is True
    assert created_2 is False
    assert city_id_1 == city_id_2
    assert calls["n"] == 1  # second call reused the cache, no re-geocode
    assert client.cities.rows[0]["radius_km"] == 12.0  # radius still updated on the cache hit


def test_no_hint_backfills_missing_region_without_full_regeocode_skip():
    client = FakeClient()
    client.cities.rows.append(
        {"id": "city-1", "country": "US", "city": "Boston", "region": None, "radius_km": 10.0}
    )
    calls = {"n": 0}

    def geocode_fn():
        calls["n"] += 1
        return (42.3, -71.0, "Massachusetts")

    city_id, created = get_or_create_city(client, "US", "Boston", 10.0, geocode_fn)
    assert created is False
    assert city_id == "city-1"
    assert calls["n"] == 1  # backfill call happened
    assert client.cities.rows[0]["region"] == "Massachusetts"


# --- get_or_create_city: hinted path ------------------------------------------


def test_hinted_path_always_regeocodes_even_if_row_exists():
    calls = {"n": 0}

    def geocode_fn():
        calls["n"] += 1
        return (39.03, 1.57, "Illes Balears")

    client = FakeClient()
    get_or_create_city(client, "ES", "San Carlos", 20.0, geocode_fn, region_hint="Balears")
    get_or_create_city(client, "ES", "San Carlos", 20.0, geocode_fn, region_hint="Balears")

    assert calls["n"] == 2  # re-geocoded both times, cache was not trusted


def test_hinted_path_converges_two_calls_onto_same_row_by_resolved_region():
    def geocode_fn():
        # Nominatim's own resolved region differs from the hint string.
        return (39.03, 1.57, "Illes Balears")

    client = FakeClient()
    city_id_1, created_1 = get_or_create_city(client, "ES", "San Carlos", 20.0, geocode_fn, region_hint="Balears")
    city_id_2, created_2 = get_or_create_city(
        client, "ES", "San Carlos", 25.0, geocode_fn, region_hint="  balears  "
    )

    assert created_1 is True
    assert created_2 is False
    assert city_id_1 == city_id_2
    assert len(client.cities.rows) == 1
    assert client.cities.rows[0]["region"] == "Illes Balears"
    assert client.cities.rows[0]["radius_km"] == 25.0


def test_hinted_path_keeps_distinct_rows_for_distinct_resolved_regions():
    responses = {
        "Balears": (39.03, 1.57, "Illes Balears"),
        "Castilla y Leon": (41.65, -4.72, "Castilla y Leon"),
    }

    def make_geocode_fn(hint):
        def geocode_fn():
            return responses[hint]

        return geocode_fn

    client = FakeClient()
    city_id_1, _ = get_or_create_city(
        client, "ES", "San Carlos", 20.0, make_geocode_fn("Balears"), region_hint="Balears"
    )
    city_id_2, _ = get_or_create_city(
        client, "ES", "San Carlos", 20.0, make_geocode_fn("Castilla y Leon"), region_hint="Castilla y Leon"
    )

    assert city_id_1 != city_id_2
    assert len(client.cities.rows) == 2


if __name__ == "__main__":
    # Neutralize Nominatim's 1req/sec throttle sleep for test speed — the
    # throttling behavior itself isn't under test here.
    geocode._throttle = lambda: None
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all geocode/get_or_create_city tests passed")
