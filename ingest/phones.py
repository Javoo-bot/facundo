"""Phone number normalization to E.164-style international format, using
`phonenumbers` (Google's libphonenumber port) with the florist's country as
the default parsing region.

`country_to_region` resolves a country name or code (e.g. "Spain", "US",
"United States") to an ISO-3166-1 alpha-2 region string once per ingest run
(see `main.py`), which `normalize_phone` then uses as the default region for
numbers that don't already carry a leading "+<country code>" (Maps phones
usually do; scraped website phones often don't).

Honest, no data loss: a number that can't be parsed or doesn't validate is
returned unchanged rather than nulled out or guessed at.
"""

import pycountry
import phonenumbers
from phonenumbers import PhoneNumberFormat


def country_to_region(country: str | None) -> str | None:
    """Resolve `country` to an ISO-3166-1 alpha-2 region code that
    `phonenumbers` understands (e.g. "Spain" -> "ES", "US" -> "US",
    "United States" -> "US", "UK" -> "GB").

    Returns None when it can't be resolved — `normalize_phone` still works
    without a region for numbers that already start with "+<country code>";
    only region-less local numbers are left unnormalized in that case.
    """
    if not country:
        return None
    country = country.strip()
    if not country:
        return None

    # Exact alpha-2 / alpha-3 code match first (cheap, unambiguous).
    by_alpha2 = pycountry.countries.get(alpha_2=country.upper())
    if by_alpha2:
        return by_alpha2.alpha_2
    by_alpha3 = pycountry.countries.get(alpha_3=country.upper())
    if by_alpha3:
        return by_alpha3.alpha_2

    # Fuzzy name match ("Spain", "United States", common name variants).
    try:
        matches = pycountry.countries.search_fuzzy(country)
    except LookupError:
        return None
    return matches[0].alpha_2 if matches else None


def normalize_phone(raw: str | None, region: str | None) -> str | None:
    """Normalize `raw` to international format
    (`phonenumbers.format_number(..., PhoneNumberFormat.INTERNATIONAL)`,
    e.g. "+34 612 34 56 78"), using `region` as the default country for
    numbers without a leading "+<country code>".

    Returns `raw` unchanged (not None) if it's falsy, unparseable, or fails
    validation — never fabricates or drops data.
    """
    if not raw:
        return raw
    try:
        parsed = phonenumbers.parse(raw, region)
    except phonenumbers.NumberParseException:
        return raw
    if not phonenumbers.is_valid_number(parsed):
        return raw
    return phonenumbers.format_number(parsed, PhoneNumberFormat.INTERNATIONAL)
