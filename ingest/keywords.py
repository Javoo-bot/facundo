"""Localized florist search-keyword cache, backed by the `country_keywords`
Supabase table.

Problem: searching the English "florist" under-collects in non-English
destinations ("florista"/"floristería" surface different Google Maps results).
This module derives, caches, and serves the local-language search terms (plus
the Google Maps `language` code) to use for a given country.

Cache-first: `get_keywords_for_country` reads `country_keywords` first; on a
miss it asks Claude (structured output) for the terms, writes the cache, and
returns. Re-running ingest for the same country never re-derives unless the
cache row is removed or `upsert_keywords_for_country` is called with a new
user-confirmed set (e.g. from a future "edit keywords" UI).
"""

from supabase import Client

from prompts import KEYWORD_SUGGESTION_PROMPT, KeywordSuggestion

MODEL = "claude-sonnet-5"


def normalize_country(country: str) -> str:
    """Canonicalize a country string so casing variants collapse to one
    cache/DB key. Short strings are treated as acronyms and upper-cased
    ("us"/"US"->"US", "uk"->"UK", "uae"->"UAE"); longer names are title-cased
    ("spain"/"SPAIN"->"Spain", "united states"->"United States"). Existing
    "US"/"Spain" rows are unchanged, so no data migration is needed.
    """
    country = country.strip()
    return country.upper() if len(country) <= 3 else country.title()


def get_keywords_for_country(client: Client, country: str) -> tuple[list[str], str]:
    """Return (keywords, language) for `country`, cache-first.

    On a cache miss, calls Claude for the common local-language florist
    search terms (including relevant regional/co-official languages) plus
    the Google Maps `language` code, writes the result to `country_keywords`,
    and returns it.
    """
    country = normalize_country(country)
    existing = (
        client.table("country_keywords")
        .select("keywords, language")
        .eq("country", country)
        .limit(1)
        .execute()
    )
    if existing.data:
        row = existing.data[0]
        return row["keywords"], row["language"]

    keywords, language = _derive_keywords_via_claude(country)
    upsert_keywords_for_country(client, country, keywords, language)
    return keywords, language


def upsert_keywords_for_country(
    client: Client, country: str, keywords: list[str], language: str
) -> None:
    """Write (or overwrite) the cached keyword set for `country`.

    Used both by `get_keywords_for_country` on a cache miss, and directly by
    callers (e.g. `main.py --keywords`, or a future dashboard "confirm
    keywords" action) to store a user-confirmed set.
    """
    country = normalize_country(country)
    client.table("country_keywords").upsert(
        {"country": country, "keywords": keywords, "language": language},
        on_conflict="country",
    ).execute()


def _derive_keywords_via_claude(country: str) -> tuple[list[str], str]:
    from llm_client import get_llm_client, routed_model

    claude = get_llm_client()
    prompt = KEYWORD_SUGGESTION_PROMPT.format(country=country)
    response = claude.messages.parse(
        model=routed_model(MODEL),
        max_tokens=512,
        messages=[{"role": "user", "content": prompt}],
        output_format=KeywordSuggestion,
    )
    result: KeywordSuggestion = response.parsed_output
    return result.keywords, result.language
