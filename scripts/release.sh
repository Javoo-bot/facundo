#!/usr/bin/env bash
#
# Tag origin/main for production deploy — the ONLY way a release should ship.
#
# WHY THIS EXISTS
# ----------------
# Production used to deploy on every push to a `v0.2` branch that existed
# solely to receive merges of main (see git history for scripts/sync-v0.2.sh
# and the "v0.2 is downstream only" CI job this replaced, 2026-08-21). Every
# sync was a deploy, whether or not that was the intent, and keeping the
# branch itself clean (no direct commits, no drift from main) was its own
# ongoing chore.
#
# A `release-*` tag makes "ship this commit to production" a deliberate,
# named act instead of a side effect of branch hygiene, and it points straight
# at a commit on main — there is no separate branch to keep in sync.
# .github/workflows/deploy-v2.yml and deploy-ingest-worker.yml both trigger
# off the SAME tag pattern, deliberately: the dashboard and the ingest worker
# share a database, and a past incident (2026-08-11, see
# deploy-ingest-worker.yml's header) came from the worker running behind the
# dashboard. One tag ships both, in step.
#
# Usage:
#     ./scripts/release.sh            # tag origin/main and report; does not push
#     ./scripts/release.sh --push     # tag and push — THIS TRIGGERS A DEPLOY
#
# Safe to run from a dirty working tree: it never touches your working tree
# or checks anything out — it tags origin/main directly.

set -euo pipefail

PUSH=0
[ "${1:-}" = "--push" ] && PUSH=1

echo "Fetching…"
git fetch --quiet origin main

TARGET=$(git rev-parse origin/main)

# Refuse to re-tag a commit that's already released — a second tag on the
# same commit is never useful and usually means the caller forgot they
# already shipped this.
EXISTING=$(git tag --points-at "$TARGET" --list 'release-*')
if [ -n "$EXISTING" ]; then
  echo "origin/main ($TARGET) is already tagged: $EXISTING" >&2
  echo "Nothing to do." >&2
  exit 0
fi

# release-YYYY-MM-DD, with a numeric suffix if that date's tag is taken
# (a second release the same day). Uses UTC so the date is unambiguous
# regardless of where this runs.
DATE=$(date -u +%Y-%m-%d)
TAG="release-$DATE"
N=2
while git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1 || git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1; do
  TAG="release-$DATE-$N"
  N=$((N + 1))
done

echo
echo "Tagging origin/main ($TARGET) as $TAG:"
git log --oneline -5 "$TARGET"
echo

git tag -a "$TAG" "$TARGET" -m "Release $TAG"

echo "Tagged locally as $TAG."

if [ "$PUSH" = "1" ]; then
  echo
  echo "Pushing $TAG — this triggers the production deploy (dashboard + ingest worker)."
  git push origin "$TAG"
else
  echo
  echo "Not pushed. Run 'git push origin $TAG' when you're ready (it deploys)."
  echo "Or re-run this script with --push."
fi
