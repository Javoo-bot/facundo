"""One-time backfill: fill in `cities.region` for rows that don't have one.

Region is captured for free from Nominatim during normal ingest (see
geocode.py / db.get_or_create_city), so most *new* cities already get it and
existing cities backfill it automatically the next time ingest re-runs for
them. This script is for cities you don't want to (or can't) re-ingest just
to pick up the region.

    cd ingest && uv run python backfill_regions.py

Idempotent and safe to re-run: it only touches rows where `region` is still
null/empty, and does nothing if none remain.
"""

import os
import sys

from dotenv import load_dotenv

from db import get_client
from geocode import geocode_city_center

REQUIRED_ENV_VARS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]

load_dotenv()


def main() -> None:
    missing = [name for name in REQUIRED_ENV_VARS if not os.environ.get(name)]
    if missing:
        print(f"Missing required environment variables: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    client = get_client()
    rows = (
        client.table("cities")
        .select("id, country, city")
        .is_("region", "null")
        .execute()
        .data
    )

    if not rows:
        print("No cities are missing a region. Nothing to do.")
        return

    print(f"Found {len(rows)} city row(s) missing a region.")

    updated = 0
    skipped = 0
    for row in rows:
        city_id, country, city = row["id"], row["country"], row["city"]
        try:
            # geocode_city_center() itself enforces Nominatim's <=1 req/sec
            # throttle, so looping over rows here stays polite automatically.
            _, _, region = geocode_city_center(country, city)
        except ValueError as exc:
            print(f"  SKIP {city}, {country}: {exc}")
            skipped += 1
            continue

        if region is None:
            print(f"  {city}, {country}: no region found (Nominatim gave no state/province/region/state_district)")
            skipped += 1
            continue

        client.table("cities").update({"region": region}).eq("id", city_id).execute()
        print(f"  {city}, {country}: region = {region}")
        updated += 1

    print(f"Done. Updated {updated} row(s), skipped {skipped} row(s) (no region available).")


if __name__ == "__main__":
    main()
