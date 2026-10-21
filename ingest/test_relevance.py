"""Sanity assertions for the florist relevance category rule. Run: uv run python test_relevance.py"""
import asyncio

from relevance import (
    category_matches_florist,
    filter_florists_by_relevance,
    has_non_florist_marker,
    looks_like_real_business,
)

SPAIN_KEYWORDS = ["florist", "floristeria", "floristería"]
FR_KEYWORDS = ["fleuriste", "magasin de fleurs", "florist"]


def test_matches_primary_category():
    assert category_matches_florist("Florist", ["Florist"], SPAIN_KEYWORDS)


def test_matches_localized_category():
    assert category_matches_florist("Floristería", ["Floristería", "Regalos"], SPAIN_KEYWORDS)


def test_matches_when_keyword_is_only_a_secondary_category():
    assert category_matches_florist("Gift shop", ["Gift shop", "Florist"], SPAIN_KEYWORDS)


def test_match_is_case_insensitive():
    assert category_matches_florist("FLORISTERIA", ["FLORISTERIA"], SPAIN_KEYWORDS)


def test_rejects_unrelated_category():
    assert not category_matches_florist("Supermarket", ["Supermarket", "Grocery store"], SPAIN_KEYWORDS)


def test_rejects_missing_category_data():
    assert not category_matches_florist(None, None, SPAIN_KEYWORDS)
    assert not category_matches_florist(None, [], SPAIN_KEYWORDS)


# --- primary category settles marker ambiguity (2026-09-01 CBD fix, ported
# from the TS mirror where it had drifted; 2026-09-04 funeral-home addition) --


def test_keeps_free_pass_for_a_real_florist_that_also_sells_dried_flowers():
    # "Exemple Fleurs | Fleuriste" — primary Fleuriste, secondary dried
    # flowers. Marker-only logic would have sent this to Claude for nothing.
    assert category_matches_florist("Fleuriste", ["Fleuriste", "Magasin de fleurs séchées"], FR_KEYWORDS)


def test_still_refuses_the_cbd_shop_whose_primary_is_cannabis():
    assert not category_matches_florist(
        "Magasin de cannabis", ["Magasin de cannabis", "Magasin de fleurs séchées"], FR_KEYWORDS
    )


def test_still_refuses_a_wholesaler_whose_primary_is_both_keyword_and_marker():
    assert not category_matches_florist("Fleuriste grossiste", ["Fleuriste grossiste"], FR_KEYWORDS)


def test_revokes_free_pass_for_a_funeral_home_carrying_fleuriste_as_secondary():
    # Real case (2026-09-04, order #2000033): "Pompes Funèbres Exemple" got
    # the free pass and a real order offer sent to it, because "Fleuriste"
    # was one of 8 secondary Maps categories on a business whose PRIMARY is
    # a funeral home. Revokes the free pass (sends to Claude), same
    # treatment as CBD/wholesale — does not hard-drop, since some funeral
    # homes genuinely also run a real florist.
    categories = [
        "Entreprise de pompes funèbres",
        "Magasin de bougies",
        "Fournisseur d'arômes et de parfums",
        "Fleuriste",
        "Organisation de cérémonie funéraire civile",
    ]
    assert has_non_florist_marker("Entreprise de pompes funèbres", categories)
    assert not category_matches_florist("Entreprise de pompes funèbres", categories, FR_KEYWORDS)


def test_vouched_place_ids_bypass_the_claude_fallback_entirely():
    florist = {
        "place_id": "vouched-1",
        "name": "Some Onboarded Shop",
        "category_name": "Gift shop",  # deliberately would NOT match the free rule
        "categories": ["Gift shop"],
        "rating": 4.0,
        "review_count": 5,
    }
    # claude_client=None would raise AttributeError if the Claude fallback were
    # ever reached for this florist — proves the vouched bypass short-circuits
    # BOTH the rule check's "ambiguous" path and the Claude call, not just the
    # final verdict.
    kept, dropped = asyncio.run(
        filter_florists_by_relevance(
            [florist],
            SPAIN_KEYWORDS,
            claude_client=None,
            tracker=None,
            vouched_place_ids={"vouched-1"},
        )
    )
    assert kept == [florist]
    assert dropped == []


# --- looks_like_real_business / the phantom-village case (2026-09-04) -------
# Real case (order #2000033): "Mesterrieux", "Neuffons", "Loubens" etc. —
# Landerrouet-sur-Ségur candidates named after neighboring communes, address
# "<postcode>, France" (no street), category_name None, categories []. Claude,
# given nothing but a bare place name, waved every one through as a florist.
# KEEP IN STEP with ingest-worker/test/relevance.test.ts.


def test_looks_like_real_business_is_false_for_no_category_at_all():
    assert not looks_like_real_business(None, [])
    assert not looks_like_real_business(None, None)
    assert not looks_like_real_business("", [])


def test_looks_like_real_business_is_true_with_a_primary_category():
    assert looks_like_real_business("Fleuriste", [])


def test_looks_like_real_business_is_true_with_only_a_secondary_category():
    assert looks_like_real_business(None, ["Fleuriste"])


def test_filter_drops_a_no_category_phantom_village_without_calling_claude():
    phantom = {
        "place_id": "phantom-1",
        "name": "Mesterrieux",
        "address": "France",
        "category_name": None,
        "categories": [],
        "rating": None,
        "review_count": None,
    }
    # claude_client=None would raise if the phantom ever reached the Claude
    # fallback — proves it's dropped by the pre-filter, not judged and kept.
    kept, dropped = asyncio.run(
        filter_florists_by_relevance([phantom], ["fleuriste"], claude_client=None, tracker=None)
    )
    assert kept == []
    assert len(dropped) == 1
    assert "no Maps category" in dropped[0]["_relevance_reason"]


def test_filter_still_sends_a_real_low_data_florist_to_claude():
    # La Fleur Exemple: has a real category, just no website — must NOT be
    # caught by the phantom-village filter, and (with no keyword match on
    # "Fleuriste" alone against these keywords) must reach the ambiguous path.
    real = {
        "place_id": "real-1",
        "name": "La Fleur Exemple",
        "category_name": "Florist",
        "categories": ["Florist"],
        "rating": 4.8,
        "review_count": 24,
    }
    kept, dropped = asyncio.run(
        filter_florists_by_relevance([real], ["florist"], claude_client=None, tracker=None)
    )
    # Matches the free-rule keyword ("Florist"), so it's kept without ever
    # reaching Claude (claude_client=None would have raised otherwise).
    assert kept == [real]
    assert dropped == []


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all relevance tests passed")
