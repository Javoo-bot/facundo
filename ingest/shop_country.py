"""The country a florist shop is ACTUALLY in, read from its own address.

Python twin of ``dashboard/lib/shopCountry.ts`` — keep the two in step (separate
builds, no shared module, same convention as ``locales.py`` /
``ingest-worker/src/locale.ts``).

WHY THIS EXISTS: until 2026-09-16 the ingest resolved ONE region per city
(``main.py``: ``phone_region = country_to_region(country)``) and applied it to
every florist in that city's 20 km radius. Radii cross borders, so this was
wrong for whole populations at once — 46 of Founex (CH)'s 174 shops are in
France, and Basel holds shops in three countries.

That single assumption caused both halves of the order #2000034 failure:

  * LANGUAGE — a Cranves-Sales (FR) shop inherited CH, which maps to no
    supported locale, so its offer email went out in English.
  * PHONE — the shop's local landline "04 50 00 11 22" was parsed against the
    city's region, CH. The damage was done by the Cloudflare Worker, not by
    this package: libphonenumber-js ACCEPTS that input as a valid Swiss number
    and returned "+41 45 000 11 22", which Telnyx then rejected with "Invalid
    destination number". python-phonenumbers rejects the same input under CH,
    so ``normalize_phone`` here keeps it verbatim — this path was immune by
    accident. It takes the shop's own region anyway (``phone_region_for``)
    rather than depend on two libraries continuing to disagree.

See docs/superpowers/specs/2026-09-16-florist-locale-and-reply-failures-design.md.
"""

from __future__ import annotations

import gettext
import re
import unicodedata

import pycountry

from locales import region_to_locale

# Google Maps returns the country name in the language of the scrape, so the
# address column holds names in many languages at once: "Frankreich" and
# "France" both appear, as do "Schweiz", "España", "Danmark", "Polska",
# "Türkiye", "Ελλάδα", "ישראל" and "تونس". This is every language observed in
# the production `florists.address` column as of 2026-09-16, plus the obvious
# neighbours. Mirrors NAME_LOCALES in the TS twin.
NAME_LANGUAGES = [
    "en", "de", "fr", "es", "it", "pt", "nl", "ca", "da", "sv", "nb", "fi",
    "et", "pl", "cs", "sk", "hr", "sr", "ro", "bg", "el", "tr", "he", "ar",
]


def _normalize(s: str) -> str:
    """Casefold and strip diacritics so "España" matches "espana" and
    "Türkiye" matches "turkiye". Non-Latin scripts (Greek, Hebrew, Cyrillic,
    Arabic) pass through unchanged, which is correct — they are already exact.
    """
    decomposed = unicodedata.normalize("NFD", s)
    stripped = "".join(c for c in decomposed if not unicodedata.combining(c))
    return stripped.casefold().strip()


def _translator(lang: str):
    """pycountry's gettext catalogue for one language, or None when it has no
    translations for it. The domain was renamed between pycountry releases, so
    both spellings are tried before giving up."""
    for domain in ("iso3166-1", "iso3166"):
        try:
            return gettext.translation(domain, pycountry.LOCALES_DIR, languages=[lang])
        except (FileNotFoundError, OSError):
            continue
    return None


def _build_index() -> dict[str, str]:
    """normalized country name (in ANY supported language) -> alpha-2.

    Built once at import rather than per lookup. A name claimed by two
    DIFFERENT countries across languages is dropped, not arbitrated: an
    ambiguous token must resolve to None and let the caller fall back. Guessing
    is what put a French shop on a Swiss country code in the first place.
    """
    index: dict[str, str] = {}
    ambiguous: set[str] = set()

    def add(name: str | None, alpha2: str) -> None:
        if not name:
            return
        key = _normalize(name)
        if not key:
            return
        seen = index.get(key)
        if seen is not None and seen != alpha2:
            ambiguous.add(key)
        elif seen is None:
            index[key] = alpha2

    countries = list(pycountry.countries)
    for country in countries:
        add(getattr(country, "name", None), country.alpha_2)
        add(getattr(country, "common_name", None), country.alpha_2)
        add(getattr(country, "official_name", None), country.alpha_2)

    for lang in NAME_LANGUAGES:
        if lang == "en":
            continue
        translator = _translator(lang)
        if translator is None:
            continue
        for country in countries:
            for attr in ("name", "common_name", "official_name"):
                english = getattr(country, attr, None)
                if english:
                    add(translator.gettext(english), country.alpha_2)

    for key in ambiguous:
        index.pop(key, None)
    return index


NAME_TO_ALPHA2 = _build_index()

# How many trailing comma-separated segments to consider. The country is
# usually last, but not always — Google hands back "Example Ave, 40, Uzhhorod,
# Zakarpattia Oblast, Ukrajina, 88000" with the postcode AFTER the country.
# Three covers every real shape observed without reaching far enough back to
# start matching street or city names.
TAIL_SEGMENTS = 3


def country_from_address(address: str | None) -> str | None:
    """The shop's ISO-3166-1 alpha-2 country, read from the tail of its
    address, or None when the address does not name one.

    NONE IS A FIRST-CLASS ANSWER and callers must keep their existing fallback:
    roughly 5% of production rows genuinely have no country in the address
    ("Carrer del Carme 10, Girona", "None, Boston, MA 02122"). Returning a
    guess for those would be strictly worse than returning nothing.
    """
    if not address or not address.strip():
        return None
    parts = [p.strip() for p in address.split(",") if p.strip()]
    for segment in reversed(parts[-TAIL_SEGMENTS:]):
        hit = NAME_TO_ALPHA2.get(_normalize(segment))
        if hit:
            return hit
    return None


# Swiss postcodes are allocated by region and the regions are linguistic.
# Measured against all 1,061 Swiss-address shops in production on 2026-09-16:
# 243 fall in the French ranges, 818 in the German ones, and ZERO in the
# Italian ones — so the Ticino arm is correctness for the first one rather than
# something today's data exercises. Boundaries are deliberately coarse:
# Fribourg (17xx) and Biel/Bienne (25xx) are genuinely bilingual, and a shop
# there may get the less likely of its two languages. That is a far smaller
# error than the status quo (all 1,061 get English), and a stored
# `florists.locale` still overrides it.
SWISS_RANGES = [
    (1000, 2999, "fr"),  # Geneva, Vaud, Neuchâtel, Jura
    (6500, 6999, "it"),  # Ticino, Italian Grisons
]

_FOUR_DIGITS = re.compile(r"\b\d{4}\b")


def swiss_locale_from_postcode(address: str | None) -> str | None:
    """The language implied by a Swiss address's postcode, or None when the
    address carries no 4-digit postcode we can read (e.g. "Zürich,
    Switzerland", of which production has exactly one)."""
    if not address:
        return None
    # Every match is scanned, not just the first: the street number comes
    # earlier in the string than the postcode does, so "Rue du
    # Rue-de-l'Exemple 16, 1205 Genève" would otherwise be read as 16.
    for raw in _FOUR_DIGITS.findall(address):
        pc = int(raw)
        if pc < 1000:
            continue
        for low, high, locale in SWISS_RANGES:
            if low <= pc <= high:
                return locale
        return "de"  # 3000-6499 or 7000-9999: German-speaking
    return None


def locale_from_address(address: str | None) -> str | None:
    """The outbound locale implied by a shop's own address, or None when the
    address cannot decide it (no country named, a country with no supported
    catalogue, or a Swiss address with no readable postcode)."""
    country = country_from_address(address)
    if not country:
        return None
    # CH is the case a country code provably cannot answer — see the
    # deliberately-absent note in locales.py.
    if country == "CH":
        return swiss_locale_from_postcode(address)
    return region_to_locale(country)


def phone_region_for(address: str | None, city_region: str | None) -> str | None:
    """The region to parse this shop's LOCAL phone numbers against.

    The shop's own address wins; the city's region is the fallback for the ~5%
    that name no country. A French landline written "04 50 00 11 22" parses to
    +33… under FR. Under CH, python-phonenumbers declines it but the Worker's
    libphonenumber-js turns it into a plausible-but-wrong +41… — which is what
    reached production. See ingest-worker/src/shopCountry.ts.
    """
    return country_from_address(address) or city_region
