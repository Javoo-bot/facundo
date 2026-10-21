#!/usr/bin/env bash
# psql against the STAGING Supabase project, via the IPv4 pooler (the direct
# db.<ref>.supabase.co host is IPv6-only). Reads the password from ../.env's
# CONNECTION_STRING so no secret lives in a command line or this file.
# Usage: scripts/dev/staging-psql.sh -c "select 1"   |   -f file.sql
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PW="$(grep '^CONNECTION_STRING=' "$ROOT/.env" | sed 's#.*postgres:\([^@]*\)@.*#\1#' | tr -d '\r')"
PSQL="/c/Program Files/PostgreSQL/18/bin/psql.exe"; command -v psql >/dev/null 2>&1 && PSQL=psql
PGPASSWORD="$PW" exec "$PSQL" "host=aws-0-your-region.pooler.supabase.com port=6543 dbname=postgres user=postgres.your-staging-project-ref sslmode=require" -At -F' | ' "$@"
