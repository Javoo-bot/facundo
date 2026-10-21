"""Tests for shop_country.py — the Python twin of dashboard/lib/shopCountry.ts.

Every address literal is a REAL row from the production `florists` table,
sampled 2026-09-16 (one per distinct trailing token, shop names omitted —
these are public business listings, not personal data). They are here because
the shapes are what broke: the parser was written against them, not against
invented examples.

The ingest has no pytest dependency, so this runs standalone:

    uv run python test_shop_country.py
"""

from __future__ import annotations

from shop_country import (
    country_from_address,
    locale_from_address,
    phone_region_for,
    swiss_locale_from_postcode,
)

REAL_ADDRESSES = [
    ("14 Av. de l'Exemple, 69300 Caluire-et-Cuire, France", "FR"),
    ("831 Rte de l'Exemple, 74380 Cranves-Sales, Frankreich", "FR"),
    ("Rue de l'Exemple 16, 1205 Genève, Schweiz", "CH"),
    ("Zürich, Switzerland", "CH"),
    ("Beispielgasse 13, 1030 Wien, Österreich", "AT"),
    ("Beispielstraße 32, 79576 Weil am Rhein, Deutschland", "DE"),
    ("Av. del Ejemplo, s/n, Poniente Sur, 14004 Córdoba, España", "ES"),
    ("Av. do Exemplo 7C, 2800-011 Almada, Portugal", "PT"),
    ("Rua Exemplo, 100 - Lj 1, Rio de Janeiro - RJ, 22250-040, Brasil", "BR"),
    ("Calle Ejemplo 1000, Cdad. Autónoma de Buenos Aires, Argentina", "AR"),
    ("Cra. 1 #1-00, Centro, Cartagena de Indias, Bolívar, Colombia", "CO"),
    ("C. Ejemplo 143, Santo Domingo 10211, República Dominicana", "DO"),
    ("Village Exemple, Casablanca 27182, Maroc", "MA"),
    ("Eksempelvej 48, 2300 København, Danmark", "DK"),
    ("Przykladowa 2, 80-180 Kowale, Polska", "PL"),
    ("Exempelvägen 3, 438 93 Landvetter, Sverige", "SE"),
    ("Örnek Mah, 1. Cd. 1/A, 06520 Çankaya/Ankara, Türkiye", "TR"),
    ("Παραδείγματος 34, Αθήνα 112 53, Ελλάδα", "GR"),
    ("דוגמה 1, תל אביב-יפו, ישראל", "IL"),
]


def test_country_from_address_reads_any_language() -> None:
    for address, expected in REAL_ADDRESSES:
        got = country_from_address(address)
        assert got == expected, f"{address!r}: expected {expected}, got {got}"


def test_country_is_not_always_the_last_segment() -> None:
    # Google puts the postcode after the country on this one, which is why the
    # parser scans three trailing segments instead of one.
    assert (
        country_from_address("Example Ave, 40, Uzhhorod, Zakarpattia Oblast, Ukrajina, 88000")
        == "UA"
    )


def test_returns_none_rather_than_guessing() -> None:
    # ~5% of production rows name no country at all. A guess is worse than
    # nothing: it is precisely how a French shop ended up on a Swiss code.
    for address in ("Carrer del Carme 10, Girona", "None, Boston, MA 02122",
                    "Rue de la Gare 3, 88000", "", None):
        assert country_from_address(address) is None, address


def test_matches_whole_segments_not_substrings() -> None:
    assert country_from_address("Av. Exemple, 41, AD500 Andorra la Vella, Andorra") == "AD"
    assert country_from_address("Av. Exemple, 41, AD500 Andorra la Vella") is None


def test_swiss_postcode_splits_by_language_region() -> None:
    assert swiss_locale_from_postcode("Rue de l'Exemple 16, 1205 Genève, Schweiz") == "fr"
    assert swiss_locale_from_postcode("Rue de Bourg 1, 1003 Lausanne, Schweiz") == "fr"
    assert swiss_locale_from_postcode("Rue du Seyon 1, 2000 Neuchâtel, Schweiz") == "fr"
    assert swiss_locale_from_postcode("Bahnhofstrasse 1, 8001 Zürich, Schweiz") == "de"
    assert swiss_locale_from_postcode("Freie Strasse 1, 4051 Basel, Schweiz") == "de"
    assert swiss_locale_from_postcode("Bahnhofstrasse 1, 6300 Zug, Schweiz") == "de"
    assert swiss_locale_from_postcode("Via Nassa 5, 6900 Lugano, Schweiz") == "it"


def test_swiss_postcode_is_not_fooled_by_a_house_number() -> None:
    # The street number precedes the postcode in the string.
    assert swiss_locale_from_postcode("Rue de l'Exemple 16, 1205 Genève, Schweiz") == "fr"
    assert swiss_locale_from_postcode("Bahnhofstrasse 9000, 1205 Genève, Schweiz") == "de"
    assert swiss_locale_from_postcode("Zürich, Switzerland") is None
    assert swiss_locale_from_postcode(None) is None


def test_locale_from_address() -> None:
    # The order #2000034 florist: French shop inside the Founex (CH) radius.
    assert locale_from_address("831 Rte de l'Exemple, 74380 Cranves-Sales, Frankreich") == "fr"
    assert locale_from_address("Rue de l'Exemple 16, 1205 Genève, Schweiz") == "fr"
    assert locale_from_address("Freie Strasse 1, 4051 Basel, Schweiz") == "de"
    assert locale_from_address("Beispielgasse 13, 1030 Wien, Österreich") == "de"
    assert locale_from_address("C. Ejemplo 143, Santo Domingo 10211, República Dominicana") == "es"
    # Country read fine, no catalogue for it — EN is the right answer, not a gap.
    assert locale_from_address("Eksempelvej 48, 2300 København, Danmark") is None
    assert locale_from_address("Carrer del Carme 10, Girona") is None
    assert locale_from_address("Zürich, Switzerland") is None


def test_phone_region_prefers_the_shop_over_the_city() -> None:
    # The whole phone half of #2000034: this shop's local landline
    # "04 50 00 11 22" parsed under CH became +41450001122, which is a
    # structurally valid Swiss number, so libphonenumber passed it and Telnyx
    # rejected the send.
    cranves = "831 Rte de l'Exemple, 74380 Cranves-Sales, Frankreich"
    assert phone_region_for(cranves, "CH") == "FR"
    # No country in the address: the city's region still answers.
    assert phone_region_for("Carrer del Carme 10, Girona", "CH") == "CH"
    assert phone_region_for(None, "ES") == "ES"
    assert phone_region_for(None, None) is None


def test_normalize_phone_end_to_end() -> None:
    """Through the real normalize_phone.

    Note what this does NOT show: python-phonenumbers REJECTS this landline
    under CH, so normalize_phone keeps it verbatim and the Python ingest never
    produced the bad +41 number. The Worker did — libphonenumber-js ACCEPTS the
    same input under CH and returns "+41 45 000 11 22", the exact value stored
    for this florist in production (pinned in
    ingest-worker/test/shopCountry.test.ts). The two libraries disagree on this
    number. The Python path was immune by accident, not by design, so it takes
    the shop's own region too rather than relying on that.
    """
    from phones import normalize_phone

    cranves = "831 Rte de l'Exemple, 74380 Cranves-Sales, Frankreich"
    local_landline = "04 50 00 11 22"
    # Under the city's region Python declines to guess and keeps the raw text.
    assert normalize_phone(local_landline, "CH") == local_landline
    # Under the shop's own region it produces the correct international number.
    assert normalize_phone(local_landline, phone_region_for(cranves, "CH")) == "+33 4 50 00 11 22"


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as exc:
                failures += 1
                print(f"FAIL {name}: {exc}")
    print(f"\n{failures} failure(s)")
    raise SystemExit(1 if failures else 0)
