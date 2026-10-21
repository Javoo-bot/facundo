"""Best-effort job-tracking writes for ingest runs kicked off from the dashboard.

Every function here is best-effort: a failure to write job-tracking state must
never crash or abort the actual ingest, so each Supabase call is wrapped in
try/except and failures are reported as a warning on stderr, then swallowed.
"""

from datetime import datetime, timezone

import click
from supabase import Client


def create_job(
    db: Client,
    job_id: str,
    country: str,
    city: str,
    radius_km: float,
    limit: int,
    keywords: list[str] | None,
    language: str | None,
) -> None:
    """Upsert (on id) a running job row for this ingest invocation."""
    try:
        db.table("ingest_jobs").upsert(
            {
                "id": job_id,
                "country": country,
                "city": city,
                "radius_km": radius_km,
                "limit_per_keyword": limit,
                "keywords": keywords,
                "language": language,
                "status": "running",
            }
        ).execute()
    except Exception as exc:  # noqa: BLE001 - job tracking must never break ingest
        click.echo(f"Warning: failed to create job {job_id}: {exc}", err=True)


def _append_bounded_log(existing_log: str | None, line: str, max_lines: int = 50) -> str:
    """Append `line` to `existing_log`, keeping only the last `max_lines` lines.

    Pure helper (no DB) so it can be unit-tested directly.
    """
    lines = existing_log.splitlines() if existing_log else []
    lines.append(line)
    return "\n".join(lines[-max_lines:])


def update_job_progress(db: Client, job_id: str, line: str) -> None:
    """Set last_line=line and append line to the bounded log tail."""
    try:
        existing = (
            db.table("ingest_jobs").select("log").eq("id", job_id).limit(1).execute()
        )
        existing_log = existing.data[0]["log"] if existing.data else None
        new_log = _append_bounded_log(existing_log, line)
        db.table("ingest_jobs").update({"last_line": line, "log": new_log}).eq("id", job_id).execute()
    except Exception as exc:  # noqa: BLE001 - job tracking must never break ingest
        click.echo(f"Warning: failed to update job progress for {job_id}: {exc}", err=True)


def finish_job(
    db: Client,
    job_id: str,
    status: str,
    error: str | None = None,
    usage=None,
    apify_cost_usd: float | None = None,
    florist_count: int | None = None,
) -> None:
    """Mark the job finished (succeeded/failed) and record cost + timing.

    `usage` is a usage.UsageTracker (or None for manual/terminal runs). Cost
    columns are written on BOTH success and failure paths so a partial run
    still records what it spent. Best-effort like the rest of this module.
    """
    try:
        update: dict = {
            "status": status,
            "finished_at": datetime.now(timezone.utc).isoformat(),
        }
        if error is not None:
            update["error"] = error
        if usage is not None:
            update["input_tokens"] = usage.total_input_tokens
            update["output_tokens"] = usage.total_output_tokens
            update["llm_calls"] = usage.total_calls
            update["llm_cost_usd"] = round(usage.cost_usd, 6)
            update["llm_cost_by_type"] = usage.to_by_type_dict()
        if apify_cost_usd is not None:
            update["apify_cost_usd"] = apify_cost_usd
        if florist_count is not None:
            update["florist_count"] = florist_count
        db.table("ingest_jobs").update(update).eq("id", job_id).execute()
    except Exception as exc:  # noqa: BLE001 - job tracking must never break ingest
        click.echo(f"Warning: failed to finish job {job_id}: {exc}", err=True)
