"""Poll `ingest_jobs` for queued runs and execute them via the ingest CLI.

The dashboard is deployed to Cloudflare Workers, which can't spawn Python. So
POST /api/ingest (in queue mode) inserts a `queued` ingest_jobs row instead of
spawning the CLI. This poller — running on the Mac mini next to the ingest
pipeline — watches for `queued` rows, claims one (queued -> running), and runs
`main.py` with the row's params. `main.py` owns all further status writes
(progress, succeeded/failed, cost), so this loop stays thin.

Usage (normally via the launchd agent — see POLLER.md):

    uv run python poll_jobs.py

Only one poller is expected to run at a time; the claim step is still done
optimistically (update WHERE status='queued') so a second poller can't
double-run the same job.
"""

import os
import subprocess
import sys
import time
from datetime import datetime, timezone

from dotenv import load_dotenv
from supabase import Client

from db import get_client

REQUIRED_ENV_VARS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]
POLL_INTERVAL_S = float(os.environ.get("POLLER_INTERVAL_S", "4"))
INGEST_DIR = os.path.dirname(os.path.abspath(__file__))

load_dotenv()


def _claim_next_job(db: Client) -> dict | None:
    """Claim the oldest queued job, flipping it queued -> running atomically.

    Returns the job row on success, or None if nothing is queued (or another
    poller claimed it first). Optimistic single-claim: read the oldest queued
    id, then update WHERE id=? AND status='queued' and confirm a row changed.
    """
    queued = (
        db.table("ingest_jobs")
        .select("*")
        .eq("status", "queued")
        .order("started_at", desc=False)
        .limit(1)
        .execute()
    )
    if not queued.data:
        return None
    job = queued.data[0]
    claim = (
        db.table("ingest_jobs")
        .update({"status": "running"})
        .eq("id", job["id"])
        .eq("status", "queued")
        .execute()
    )
    if not claim.data:
        # Lost the race (another poller claimed it between select and update).
        return None
    return job


def _build_args(job: dict) -> list[str]:
    """Translate a queued job row into the `uv run python main.py ...` argv.

    Mirrors what POST /api/ingest used to spawn directly. Keywords are omitted
    when null so main.py derives them itself (--language is only meaningful
    alongside --keywords). radius/limit fall back to main.py's own defaults
    when the row somehow lacks them.
    """
    args = [
        "uv",
        "run",
        "python",
        "main.py",
        "--job-id",
        str(job["id"]),
        "--country",
        job["country"],
        "--city",
        job["city"],
    ]
    if job.get("radius_km") is not None:
        args += ["--radius", str(job["radius_km"])]
    if job.get("limit_per_keyword") is not None:
        args += ["--limit", str(job["limit_per_keyword"])]
    keywords = job.get("keywords")
    if keywords:
        args += ["--keywords", ",".join(keywords)]
        if job.get("language"):
            args += ["--language", job["language"]]
    if job.get("reset_existing"):
        args.append("--reset-existing")
    if job.get("region"):
        args += ["--region", job["region"]]
    if job.get("near_lat") is not None and job.get("near_lng") is not None:
        args += ["--near-lat", str(job["near_lat"]), "--near-lng", str(job["near_lng"])]
    return args


def _run_job(job: dict) -> int:
    """Run the ingest CLI for `job` to completion; return its exit code."""
    return subprocess.run(_build_args(job), cwd=INGEST_DIR, check=False).returncode


def _reconcile(db: Client, job_id: str, exit_code: int) -> None:
    """Fail-safe: if the CLI exited without writing a terminal status, mark the
    job failed so it doesn't wedge as `running` forever. A clean run has
    already set status='succeeded'/'failed' via jobs.finish_job, so this only
    fires when main.py crashed hard (import error, kill, etc.). Guarded on
    status='running' so it never clobbers a status the CLI legitimately wrote.
    """
    try:
        db.table("ingest_jobs").update(
            {
                "status": "failed",
                "error": f"Ingest process exited with code {exit_code} without reporting completion.",
                "finished_at": datetime.now(timezone.utc).isoformat(),
            }
        ).eq("id", job_id).eq("status", "running").execute()
    except Exception as exc:  # noqa: BLE001 - reconciliation must never crash the loop
        print(f"[poller] warning: failed to reconcile job {job_id}: {exc}", file=sys.stderr)


def main() -> None:
    missing = [name for name in REQUIRED_ENV_VARS if not os.environ.get(name)]
    if missing:
        print(f"Missing required environment variables: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    db = get_client()
    print(f"[poller] watching ingest_jobs for queued runs (every {POLL_INTERVAL_S}s)…", flush=True)

    while True:
        try:
            job = _claim_next_job(db)
        except Exception as exc:  # noqa: BLE001 - a transient poll error must not kill the loop
            print(f"[poller] poll error: {exc}", file=sys.stderr)
            time.sleep(POLL_INTERVAL_S)
            continue

        if job is None:
            time.sleep(POLL_INTERVAL_S)
            continue

        label = f'{job["city"]}, {job["country"]} ({job["id"]})'
        print(f"[poller] claimed {label} — running…", flush=True)
        try:
            exit_code = _run_job(job)
        except Exception as exc:  # noqa: BLE001 - failure to even start the CLI
            print(f"[poller] failed to run {label}: {exc}", file=sys.stderr)
            _reconcile(db, job["id"], -1)
            continue
        _reconcile(db, job["id"], exit_code)
        print(f"[poller] finished {label} (exit {exit_code})", flush=True)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[poller] stopped.", flush=True)
