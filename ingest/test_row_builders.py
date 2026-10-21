"""Sanity assertions for the florist row builders. Run: uv run python test_row_builders.py

Guards the Maps-category columns specifically: the relevance filter's free rule
reads `category_name`/`categories`, but for a long time the scrape only held them
in memory and neither row builder wrote them — so an already-persisted florist
could never be re-judged without re-scraping its whole city.
"""
from main import _build_bare_row, _build_row

SCRAPED = {
    "place_id": "place-1",
    "name": "Floristería Test",
    "category_name": "Florist",
    "categories": ["Florist", "Gift shop"],
}


def test_bare_row_persists_the_maps_category():
    row = _build_bare_row(SCRAPED, "city-1", None)
    assert row["category_name"] == "Florist"
    assert row["categories"] == ["Florist", "Gift shop"]


def test_full_row_persists_the_maps_category():
    # The full row overwrites the bare row once enrichment finishes — if it
    # dropped these, the category would survive the scrape but vanish minutes
    # later, which is harder to notice than never storing it at all.
    row = _build_row(SCRAPED, "city-1", None)
    assert row["category_name"] == "Florist"
    assert row["categories"] == ["Florist", "Gift shop"]


def test_missing_category_stays_null_rather_than_guessed():
    bare = _build_bare_row({"place_id": "p", "name": "N"}, "city-1", None)
    full = _build_row({"place_id": "p", "name": "N"}, "city-1", None)
    assert bare["category_name"] is None and bare["categories"] is None
    assert full["category_name"] is None and full["categories"] is None


# --- network linking (2026-08-06) -------------------------------------------
# A florist whose "website" is its profile page on a network/franchise site
# must be LINKED to that network, because that is what tells the offer path the
# email scraped from that page is the head office's, not this shop's.

NETWORK_IDS = {"reseau-demo.fr": "net-reseau-demo", "franchisefleurs-demo.com": "net-franchise-demo"}


def test_full_row_links_a_florist_on_a_network_site():
    row = _build_row(
        {**SCRAPED, "website_url": "https://www.reseau-demo.fr/trouvez-votre-fleuriste/exemple-b/?utm_source=x",
         "email": "contact@reseau-demo.fr"},
        "city-1", None, NETWORK_IDS,
    )
    assert row["network_id"] == "net-reseau-demo"
    # The address is KEPT, not nulled — staff need to see what we picked up,
    # and the link is what stops it being used as a recipient.
    assert row["email"] == "contact@reseau-demo.fr"


def test_full_row_leaves_a_shop_on_its_own_site_unlinked():
    row = _build_row(
        {**SCRAPED, "website_url": "https://larose-demo.fr/", "email": "hello@larose-demo.fr"},
        "city-1", None, NETWORK_IDS,
    )
    assert row["network_id"] is None


def test_full_row_without_a_registry_links_nothing():
    # Callers that predate the registry must keep their old behaviour rather
    # than crashing or guessing.
    row = _build_row({**SCRAPED, "website_url": "https://www.reseau-demo.fr/x"}, "city-1", None)
    assert row["network_id"] is None


def test_full_row_handles_a_florist_with_no_website():
    row = _build_row({**SCRAPED, "website_url": None}, "city-1", None, NETWORK_IDS)
    assert row["network_id"] is None


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all row-builder tests passed")
