"""Small CLI used by the dashboard's `POST /api/keywords` route to derive (or
fetch cached) localized florist search keywords + Google Maps language code
for a country.

    python derive_keywords.py --country "Spain"
    -> {"keywords": ["florist", "florista", "floristeria", "floristería", ...], "language": "es"}

Cache-first via `keywords.get_keywords_for_country` — repeated calls for the
same country don't re-hit Claude. Prints exactly one JSON object to stdout on
success (nothing else); on failure, prints `{"error": "..."}` to stderr and
exits non-zero, so a spawning process can distinguish the two reliably.
"""

import json
import os
import sys

import click
from dotenv import load_dotenv

from db import get_client
from keywords import get_keywords_for_country

load_dotenv()

REQUIRED_ENV_VARS = ["OPENROUTER_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]


@click.command()
@click.option("--country", required=True, help='Country name, e.g. "Spain"')
def main(country: str) -> None:
    missing = [name for name in REQUIRED_ENV_VARS if not os.environ.get(name)]
    if missing:
        click.echo(json.dumps({"error": f"Missing required environment variables: {', '.join(missing)}"}), err=True)
        sys.exit(1)

    try:
        client = get_client()
        keywords, language = get_keywords_for_country(client, country)
    except Exception as exc:  # noqa: BLE001 - surface any failure to the caller as clean JSON on stderr
        click.echo(json.dumps({"error": str(exc)}), err=True)
        sys.exit(1)

    click.echo(json.dumps({"keywords": keywords, "language": language}))


if __name__ == "__main__":
    main()
