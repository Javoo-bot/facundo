"""One-time backfill: link florists to their network and score shared addresses.

Normal ingest does this per city from now on (main.py links each florist via
`sync_network_registry` and runs `sweep_shared_emails` at the end of a run), so
this script is for the florists already in the database — the ones you'd
otherwise have to re-ingest every city to fix.

    cd ingest && uv run python backfill_networks.py --dry-run   # report only
    cd ingest && uv run python backfill_networks.py             # apply

What it does, in order:

  1. Seeds `florist_networks` from networks.py::SEED_NETWORKS (idempotent; a
     kind or name corrected by hand in the dashboard is never clobbered).
  2. Links every florist whose `website_url` is on a registered network's
     domain. Their stored `email` is the network's head-office address, not
     the shop's, so the offer path stops using it — the shop is still reached
     by SMS + push.
  3. Recomputes `email_shared_count` for every florist, which catches shared
     addresses we can't attribute to a known network.
  4. Reports network CANDIDATES it found in the data but that aren't in the
     registry, so they can be reviewed and added to SEED_NETWORKS. It does not
     link florists to unregistered candidates — telling a genuine network from
     a coincidence needs a human to look at the site.

Emails are never nulled. The stored value is true of the page we scraped, staff
need to see what was picked up, and the flag is what makes it unusable as a
recipient.

Requires supabase/migrations/2026-08-06-florist-networks.sql to have been run.
Idempotent and safe to re-run.
"""

import os
import sys

from dotenv import load_dotenv

from db import get_client, sweep_shared_emails, sync_network_registry
from networks import discover_network_candidates, registrable_domain

REQUIRED_ENV_VARS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]

load_dotenv()


def _load_all_florists(client) -> list[dict]:
    """Every florist row, paged — PostgREST caps a response at 1000 rows."""
    rows: list[dict] = []
    page = 0
    while True:
        batch = (
            client.table("florists")
            .select("id, name, email, website_url, place_id, network_id, email_shared_count")
            .range(page * 1000, page * 1000 + 999)
            .execute()
            .data
            or []
        )
        rows.extend(batch)
        if len(batch) < 1000:
            break
        page += 1
    return rows


def main() -> None:
    missing = [name for name in REQUIRED_ENV_VARS if not os.environ.get(name)]
    if missing:
        print(f"Missing required environment variables: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    dry_run = "--dry-run" in sys.argv
    client = get_client()

    # --- 1. registry ---------------------------------------------------------
    if dry_run:
        existing = client.table("florist_networks").select("id, domain").execute().data or []
        network_ids = {r["domain"]: r["id"] for r in existing}
        print(f"[1/4] {len(network_ids)} network(s) already registered (dry run — seeding skipped).")
    else:
        network_ids = sync_network_registry(client)
        print(f"[1/4] Registry synced: {len(network_ids)} network(s).")

    florists = _load_all_florists(client)
    print(f"      {len(florists)} florist(s) loaded.")

    # --- 2. link florists on a network's domain ------------------------------
    to_link: dict[str, list[dict]] = {}
    for f in florists:
        domain = registrable_domain(f.get("website_url"))
        if not domain or domain not in network_ids:
            continue
        if f.get("network_id") == network_ids[domain]:
            continue  # already linked — keeps re-runs a no-op
        to_link.setdefault(domain, []).append(f)

    total_links = sum(len(v) for v in to_link.values())
    print(f"[2/4] {total_links} florist(s) to link across {len(to_link)} network(s):")
    for domain, shops in sorted(to_link.items(), key=lambda kv: -len(kv[1])):
        emails = {(s.get("email") or "").strip().lower() for s in shops if (s.get("email") or "").strip()}
        sample = ", ".join(sorted(emails)[:2]) or "no address"
        print(f"      {domain:<40} {len(shops):>4} shop(s)   [{sample}]")

    if not dry_run:
        for domain, shops in to_link.items():
            for shop in shops:
                client.table("florists").update({"network_id": network_ids[domain]}).eq(
                    "id", shop["id"]
                ).execute()
        print(f"      Linked {total_links} florist(s).")

    # --- 3. shared-address sweep --------------------------------------------
    if dry_run:
        from networks import shared_email_counts

        counts = shared_email_counts(florists)
        would_change = 0
        for f in florists:
            email = (f.get("email") or "").strip().lower()
            want = counts.get(email, 1) if email else 1
            if f.get("email_shared_count") != want:
                would_change += 1
        shared = sum(1 for c in counts.values() if c > 1)
        print(f"[3/4] {would_change} florist(s) would get a new email_shared_count "
              f"({shared} address(es) held by more than one shop).")
    else:
        changed = sweep_shared_emails(client)
        print(f"[3/4] Shared-address sweep updated {changed} florist(s).")

    # --- 4. propose networks we don't know about yet -------------------------
    unregistered = [
        c for c in discover_network_candidates(florists) if c.domain not in network_ids
    ]
    actionable = [c for c in unregistered if c.shared_email]
    print(f"[4/4] {len(actionable)} unregistered domain(s) look like networks "
          f"AND share one address — review and add to networks.py::SEED_NETWORKS:")
    for c in actionable[:25]:
        print(
            f"      {c.domain:<40} {c.shop_count:>3} shop(s), "
            f"{c.shared_email_count:>3} on {c.shared_email}  "
            f"(proposed: {c.proposed_kind})"
        )
    if len(actionable) > 25:
        print(f"      … and {len(actionable) - 25} more.")
    if unregistered and not actionable:
        print("      (none share an address, so none are producing wrong recipients)")

    print("\nDry run — nothing written." if dry_run else "\nDone.")


if __name__ == "__main__":
    main()
