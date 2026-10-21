"""Repair pass: re-run enrichment for existing florists that have a website
but no email, WITHOUT re-scraping Apify (they're already in the DB — only
`enrich_florist` needs to run again, against the `website_url` we already
have). Built for the 2026-09-01 fix to `extract_candidate_emails` (WordPress
`antispambot()`-style HTML-entity/percent-encoded email cloaking, e.g.
blumendemo.ch, flori-demo.ro) so those rows don't have to wait for their city's
next full ingest run to pick it up. `enrich.py` already left the door open
for this ("stays eligible for repair mode, which is what it is for") but no
CLI existed to walk through it until now.

Usage:
    uv run python backfill_missing_emails.py [--limit N] [--dry-run]

Targets: has_website=true, email is null, not soft-deleted/excluded, not a
test shop. Writes progressively (one florist at a time, as main.py's `on_done`
does) so an interrupted run keeps whatever it already recovered. Idempotent
and safe to re-run: rows that still don't yield an email are simply
untouched (email stays null), and rows that do are byte-for-byte what a full
ingest run would have written for that florist.
"""

import asyncio
import sys

import click
from dotenv import load_dotenv
from supabase import Client

from db import get_client, sync_network_registry, sweep_shared_emails
from enrich import LlmOutage, enrich_all
from llm_client import get_llm_client
from networks import match_network
from phones import country_to_region, normalize_phone
from usage import UsageTracker

load_dotenv()

PAGE_SIZE = 1000

SELECT_COLUMNS = (
    "id,city_id,place_id,name,website_url,is_ecommerce,ecommerce_signals,"
    "email,phone_web,owner_name,shop_highlight,enrichment_notes,network_id,"
    "cities(country)"
)


def _fetch_targets(db: Client, limit: int | None) -> list[dict]:
    """Every active, non-test florist with a website and no email, paginated."""
    rows: list[dict] = []
    start = 0
    while limit is None or len(rows) < limit:
        page_end = start + PAGE_SIZE - 1
        resp = (
            db.table("florists")
            .select(SELECT_COLUMNS)
            .eq("has_website", True)
            .is_("email", "null")
            .is_("deleted_at", "null")
            .is_("excluded_at", "null")
            .eq("is_test_shop", False)
            .not_.is_("website_url", "null")
            .range(start, page_end)
            .execute()
        )
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        start += PAGE_SIZE
    return rows[:limit] if limit is not None else rows


def _build_update(florist: dict, enrichment: dict, phone_region: str | None, network_ids: dict[str, str]) -> dict:
    """Same shape main.py's `_build_row` writes for these columns — this is
    the repair-mode counterpart, scoped to enrichment-derived fields only
    (name/address/lat/lng/etc. are untouched; they came from Maps, not this
    pass)."""
    domain = match_network(florist.get("website_url"), network_ids)
    network_id = network_ids.get(domain) if domain else None
    return {
        "is_ecommerce": enrichment.get("is_ecommerce"),
        "ecommerce_signals": enrichment.get("ecommerce_signals"),
        "email": enrichment.get("email"),
        "network_id": network_id,
        "phone_web": normalize_phone(enrichment.get("phone_web"), phone_region),
        "owner_name": enrichment.get("owner_name"),
        "shop_highlight": enrichment.get("shop_highlight"),
        "enrichment_notes": enrichment.get("enrichment_notes"),
    }


@click.command()
@click.option("--limit", default=None, type=int, help="Cap the number of florists processed (omit for all).")
@click.option("--dry-run", is_flag=True, default=False, help="Enrich and report, but do not write to Supabase.")
def main(limit: int | None, dry_run: bool) -> None:
    import os

    missing = [v for v in ("OPENROUTER_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY") if not os.environ.get(v)]
    if missing:
        click.echo(f"Missing required environment variables: {', '.join(missing)}", err=True)
        sys.exit(1)

    db = get_client()
    claude = get_llm_client()
    tracker = UsageTracker()

    click.echo("Fetching backfill targets (has_website, email is null)...")
    targets = _fetch_targets(db, limit)
    click.echo(f"{len(targets)} florist(s) to re-enrich" + (" (dry run — no writes)" if dry_run else "") + ".")
    if not targets:
        return

    network_ids = sync_network_registry(db)
    recovered = 0
    processed = 0

    async def finalize(florist: dict, enrichment: dict) -> None:
        nonlocal recovered, processed
        processed += 1
        my_index = processed  # captured before any await — concurrent tasks would
        # otherwise print a stale/shared `processed` read after theirs resumes.
        if enrichment.get("email"):
            recovered += 1
        country = (florist.get("cities") or {}).get("country")
        phone_region = country_to_region(country)
        if not dry_run:
            update = _build_update(florist, enrichment, phone_region, network_ids)
            await asyncio.to_thread(
                lambda: db.table("florists").update(update).eq("id", florist["id"]).execute()
            )
        status = f"email={enrichment.get('email') or 'still none'}"
        click.echo(f"  [{my_index}/{len(targets)}] {florist.get('name')!r}: {status}")

    try:
        asyncio.run(enrich_all(targets, claude, tracker, on_done=finalize))
    except LlmOutage as exc:
        click.echo(f"Stopped: {exc}", err=True)
        click.echo(f"Recovered {recovered}/{processed} email(s) before the outage (partial run, already persisted).")
        sys.exit(1)

    if not dry_run:
        n_shared = sweep_shared_emails(db)
        click.echo(f"Shared-address sweep updated {n_shared} florist(s).")

    click.echo(
        f"Done. Recovered {recovered}/{len(targets)} email(s). "
        f"LLM cost: ${tracker.cost_usd:.2f} over {tracker.total_calls} call(s)."
    )


if __name__ == "__main__":
    main()
