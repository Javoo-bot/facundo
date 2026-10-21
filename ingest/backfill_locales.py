"""One-time backfill: fill in `florists.locale` for rows that don't have one.

Locale is derived from the city's country during normal ingest (see
main.py's `region_to_locale(phone_region)` + `db.fill_null_locales`), so cities
ingested since that landed already have it, and any city backfills itself the
next time ingest re-runs for it. This script is for florists you don't want to
(or can't) re-ingest just to pick up the language — notably any city ingested
by an older build, whose florists would otherwise keep resolving to English
(`dashboard/lib/i18n/index.ts::resolveFloristLocale`) and get English offer
emails.

    cd ingest && uv run python backfill_locales.py            # apply
    cd ingest && uv run python backfill_locales.py --dry-run  # just report

Idempotent and safe to re-run: `fill_null_locales` only touches rows where
`locale` is still null, so a florist's own language choice (self-service picker
or staff control) always wins. Cities in countries that don't imply a supported
non-English language (e.g. US) are left alone — null resolves to EN.
"""

import os
import sys

from dotenv import load_dotenv

from db import fill_null_locales, get_client
from locales import region_to_locale
from phones import country_to_region

REQUIRED_ENV_VARS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]

load_dotenv()


def main() -> None:
    missing = [name for name in REQUIRED_ENV_VARS if not os.environ.get(name)]
    if missing:
        print(f"Missing required environment variables: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    dry_run = "--dry-run" in sys.argv
    client = get_client()
    cities = client.table("cities").select("id, country, city").execute().data or []

    updated = 0
    for row in sorted(cities, key=lambda r: (r["country"], r["city"])):
        # Same two-step derivation ingest uses, so a backfilled city and a
        # freshly ingested one land on identical values.
        locale = region_to_locale(country_to_region(row["country"]))
        if not locale:
            print(f"  {row['city']}, {row['country']}: no supported non-English locale — left null (resolves to EN).")
            continue

        if dry_run:
            pending = (
                client.table("florists")
                .select("id", count="exact")
                .eq("city_id", row["id"])
                .is_("locale", "null")
                .is_("deleted_at", "null")
                .execute()
            )
            print(f"  {row['city']}, {row['country']}: would set locale '{locale}' on {pending.count} florist(s).")
            continue

        n = fill_null_locales(client, row["id"], locale)
        if n:
            print(f"  {row['city']}, {row['country']}: set locale '{locale}' on {n} florist(s).")
        updated += n

    if dry_run:
        print("Dry run — nothing written.")
    else:
        print(f"Done. Updated {updated} florist row(s).")


if __name__ == "__main__":
    main()
