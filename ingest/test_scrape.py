"""Sanity assertions for Apify item normalization. Run: uv run python test_scrape.py"""
from scrape import APIFY_LANGUAGE_OVERRIDES, _normalize_item


def test_normalize_item_captures_category_fields():
    item = {
        "placeId": "abc123",
        "title": "Floristería Test",
        "categoryName": "Florist",
        "categories": ["Florist", "Gift shop"],
    }
    result = _normalize_item(item)
    assert result["category_name"] == "Florist"
    assert result["categories"] == ["Florist", "Gift shop"]


def test_normalize_item_handles_missing_category_fields():
    item = {"placeId": "xyz789", "title": "No Category Place"}
    result = _normalize_item(item)
    assert result["category_name"] is None
    assert result["categories"] is None


def test_apify_language_override_maps_hebrew_to_legacy_code():
    # The actor's input schema rejects ISO 639-1 "he" (only accepts the old
    # Google Maps code "iw") — this is what silently failed every IL ingest
    # run until the override was added.
    assert APIFY_LANGUAGE_OVERRIDES.get("he", "he") == "iw"


def test_apify_language_override_is_noop_for_unmapped_codes():
    assert APIFY_LANGUAGE_OVERRIDES.get("es", "es") == "es"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all scrape tests passed")
