"""Sanity assertions for network detection. Run: uv run python test_networks.py"""

from networks import (
    NetworkCandidate,
    discover_network_candidates,
    email_domain,
    match_network,
    registrable_domain,
    seed_by_domain,
    shared_email_counts,
)


# --- registrable_domain -----------------------------------------------------


def test_registrable_domain_strips_scheme_www_path_and_query():
    assert (
        registrable_domain(
            "https://www.reseau-demo.fr/trouvez-votre-fleuriste/exemple-b/?utm_source=google_my_business"
        )
        == "reseau-demo.fr"
    )


def test_registrable_domain_handles_bare_hostnames():
    # A bare host has no '//', so urlparse would put it in `path`, not `netloc`.
    assert registrable_domain("blumennetz-demo.at") == "blumennetz-demo.at"
    assert registrable_domain("www.jardinerie-demo.com") == "jardinerie-demo.com"


def test_registrable_domain_collapses_subdomains():
    assert registrable_domain("https://shop.paris.franchisefleurs-demo.com/x") == "franchisefleurs-demo.com"


def test_registrable_domain_keeps_two_part_suffixes_whole():
    # Collapsing to the last two labels here would give 'co.uk', which would
    # merge every UK florist into one "network".
    assert registrable_domain("https://www.flowers.co.uk/shop") == "flowers.co.uk"
    assert registrable_domain("https://shop.blumen.co.at") == "blumen.co.at"


def test_registrable_domain_handles_country_suffixes_we_have_not_seen_yet():
    # Regression: an enumerated list of two-part suffixes omitted '.com.ar',
    # so every Argentine shop collapsed to the domain 'com.ar' and the
    # discovery pass proposed it as a 46-shop network. The rule is derived
    # now, so a country we ingest for the first time behaves correctly.
    assert registrable_domain("https://www.floreria.com.ar/x") == "floreria.com.ar"
    assert registrable_domain("https://flores.com.mx") == "flores.com.mx"
    assert registrable_domain("https://shop.blomster.com.br/a") == "blomster.com.br"
    assert registrable_domain("https://x.co.jp") == "x.co.jp"


def test_registrable_domain_does_not_over_apply_the_country_rule():
    # A non-generic second level under a two-letter TLD is a real name, and a
    # TLD longer than two letters never takes a generic second level.
    assert registrable_domain("https://shop.reseau-demo.fr") == "reseau-demo.fr"
    assert registrable_domain("https://www.fleuriste-demo.paris/x") == "fleuriste-demo.paris"
    assert registrable_domain("https://a.b.blumen.at") == "blumen.at"


def test_registrable_domain_returns_none_for_unusable_input():
    assert registrable_domain(None) is None
    assert registrable_domain("") is None
    assert registrable_domain("   ") is None
    assert registrable_domain("localhost") is None  # no dot — not a real domain


def test_registrable_domain_ignores_port_and_userinfo():
    assert registrable_domain("https://user:pw@www.reseau-demo.fr:8443/x") == "reseau-demo.fr"


def test_email_domain():
    assert email_domain("contact@reseau-demo.fr") == "reseau-demo.fr"
    assert email_domain("service.consommateurs@mail.franchisefleurs-demo.com") == "franchisefleurs-demo.com"
    assert email_domain(None) is None
    assert email_domain("not-an-email") is None


# --- the seed registry ------------------------------------------------------


def test_seed_registry_is_keyed_by_domain_and_well_formed():
    seeds = seed_by_domain()
    assert seeds["reseau-demo.fr"].kind == "network"
    assert seeds["franchisefleurs-demo.com"].kind == "franchise"
    assert seeds["artisansfleuristes-demo.com"].kind == "directory"
    # Every seed's key must equal its own domain, or ingest looks up a domain
    # and gets a different network back.
    for domain, seed in seeds.items():
        assert seed.domain == domain
        assert seed.kind in {"network", "franchise", "chain", "directory"}


def test_match_network_matches_on_the_registrable_domain():
    registry = seed_by_domain()
    assert (
        match_network("https://www.reseau-demo.fr/trouvez-votre-fleuriste/exemple-c/", registry)
        == "reseau-demo.fr"
    )
    # A shop's OWN site must not match a network.
    assert match_network("https://larose-demo.fr/", registry) is None
    assert match_network(None, registry) is None


# --- discovery --------------------------------------------------------------


def _shop(name, place_id, website, email=None):
    return {"name": name, "place_id": place_id, "website_url": website, "email": email}


def test_discover_flags_a_domain_hosting_many_shops_with_one_address():
    florists = [
        _shop("Fleurs Exemple A", "P1", "https://www.reseau-demo.fr/trouvez-votre-fleuriste/a/", "contact@reseau-demo.fr"),
        _shop("Fleurs Exemple B", "P2", "https://www.reseau-demo.fr/trouvez-votre-fleuriste/b/", "contact@reseau-demo.fr"),
        _shop("Fleurs Exemple C", "P3", "https://www.reseau-demo.fr/trouvez-votre-fleuriste/c/", "contact@reseau-demo.fr"),
        _shop("La Rose Demo", "P4", "https://larose-demo.fr/", "hello@larose-demo.fr"),
    ]
    found = discover_network_candidates(florists)
    assert [c.domain for c in found] == ["reseau-demo.fr"]
    c = found[0]
    assert c.shop_count == 3
    assert c.shared_email == "contact@reseau-demo.fr"
    assert c.shared_email_count == 3
    # Three different brand names — independent shops, so 'network', not a franchise.
    assert c.proposed_kind == "network"
    assert c.suggested_name == "reseau-demo.fr"


def test_discover_proposes_franchise_when_one_brand_dominates():
    florists = [
        _shop("Franchise Fleurs Demo", f"P{i}", "https://www.franchisefleurs-demo.com/fleuriste/paris/x", "svc@franchisefleurs-demo.com")
        for i in range(4)
    ]
    (c,) = discover_network_candidates(florists)
    assert c.proposed_kind == "franchise"
    assert c.suggested_name == "Franchise Fleurs Demo"


def test_discover_counts_storefronts_not_rows():
    # The SAME shop ingested under three cities (same place_id) is one shop.
    # Counting rows would make every duplicated single-shop site a "network".
    florists = [
        _shop("Flors Demo", "SAME", "https://flors-demo.example.com", "a@b.c") for _ in range(5)
    ]
    assert discover_network_candidates(florists) == []


def test_discover_ignores_a_domain_whose_shops_have_their_own_addresses():
    # A platform that gives each outlet its own mailbox produces no wrong
    # recipients, so it must not be proposed for email suppression.
    florists = [
        _shop("Chaine Fleurs Lecourbe", "P1", "https://chaine-fleurs.com/a", "paris15-lecourbe@chaine-fleurs.com"),
        _shop("Chaine Fleurs Nation", "P2", "https://chaine-fleurs.com/b", "paris11-nation@chaine-fleurs.com"),
        _shop("Chaine Fleurs Lyon", "P3", "https://chaine-fleurs.com/c", "lyon1@chaine-fleurs.com"),
    ]
    (c,) = discover_network_candidates(florists)
    assert c.shared_email is None
    assert c.shared_email_count == 0


def test_discover_respects_min_shops():
    florists = [
        _shop("A", "P1", "https://two-shops.fr/a", "x@two-shops.fr"),
        _shop("B", "P2", "https://two-shops.fr/b", "x@two-shops.fr"),
    ]
    assert discover_network_candidates(florists) == []
    assert len(discover_network_candidates(florists, min_shops=2)) == 1


def test_discover_orders_by_damage():
    florists = (
        [_shop(f"S{i}", f"A{i}", "https://big.fr/x", "c@big.fr") for i in range(6)]
        + [_shop(f"T{i}", f"B{i}", "https://small.fr/x", "c@small.fr") for i in range(3)]
    )
    assert [c.domain for c in discover_network_candidates(florists)] == ["big.fr", "small.fr"]


def test_discover_skips_florists_without_a_website():
    assert discover_network_candidates([_shop("A", "P1", None), _shop("B", "P2", "")]) == []


# --- the shared-address sweep ----------------------------------------------


def test_shared_email_counts_is_case_and_whitespace_insensitive():
    counts = shared_email_counts(
        [
            {"email": "Contact@Reseau-demo.fr"},
            {"email": " contact@reseau-demo.fr "},
            {"email": "hello@shop.fr"},
            {"email": None},
            {"email": "   "},
        ]
    )
    assert counts == {"contact@reseau-demo.fr": 2, "hello@shop.fr": 1}


def test_network_candidate_is_hashable_for_set_based_callers():
    c = NetworkCandidate("a.fr", 3, 3, None, 0, "network", "a.fr")
    assert len({c, c}) == 1


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all network tests passed")
