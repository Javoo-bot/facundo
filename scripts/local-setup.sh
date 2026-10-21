#!/usr/bin/env bash
# Local demo setup: a throwaway Supabase stack in Docker with demo data and a
# demo login, so the dashboard runs on localhost with zero paid API keys.
#
#   ./scripts/local-setup.sh
#   cd dashboard && npm install && npm run dev     # http://localhost:3001
#   sign in with demo@example.com / demo-password
#
# What it does:
#   1. `supabase start` (Docker) for project "facundo-cx" (ports in supabase/config.toml).
#   2. Applies supabase/schema.sql, then supabase/migrations/*.sql in date order,
#      with psql INSIDE the db container (no local psql needed). The migration
#      files use dates, not the CLI's timestamp format, so the CLI itself skips
#      them. A few are skipped or reordered; see SKIP and AFTER below.
#   3. Loads the demo partners and orders from supabase/seed/.
#   4. Allow-lists demo@example.com as an admin and creates that auth user.
#   5. Writes dashboard/.env.local pointing at the local stack (an existing,
#      different .env.local is backed up first).
#
# Re-running is safe: if the database already holds the schema it is reset
# (`supabase db reset`, which recreates the database and wipes local auth users)
# and everything above is applied again from scratch. Stop the stack with
# `supabase stop` (add --no-backup to also delete its volumes).
#
# Needs: Docker (daemon running), the Supabase CLI, curl. Works in Git Bash on
# Windows, and on macOS/Linux.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT_ID="facundo-cx"
DB_CONTAINER="supabase_db_${PROJECT_ID}"
DEMO_EMAIL="demo@example.com"
DEMO_PASSWORD="demo-password"
# Services the dashboard never talks to locally; skipping them makes start faster.
# Studio is skipped too: its health check often times out on Docker Desktop for
# Windows, which makes `supabase start` fail. The dashboard does not need it.
EXCLUDE="studio,postgres-meta,edge-runtime,logflare,vector,imgproxy,supavisor"

# Git Bash would otherwise rewrite arguments that look like paths.
export MSYS_NO_PATHCONV=1

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

for bin in docker supabase curl; do
  command -v "$bin" >/dev/null 2>&1 || die "'$bin' is not on PATH (see README prerequisites)."
done
docker info >/dev/null 2>&1 || die "Docker is installed but its daemon is not running. Start Docker Desktop and retry."

psql_db() {
  docker exec -i -e PGOPTIONS="-c client_min_messages=warning" "$DB_CONTAINER" \
    psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"
}
apply_file() { psql_db -f - < "$1" >/dev/null || die "failed while applying $1"; }
# The CLI lists every migration it skips (they are applied below instead).
quiet_cli() { "$@" 2>&1 | { grep -v 'Skipping migration' || true; }; }

say "Starting Supabase (the first run downloads ~2 GB of images)"
quiet_cli supabase start -x "$EXCLUDE"

has_schema="$(psql_db -tAc "select to_regclass('public.cities') is not null")"
if [ "$has_schema" = "t" ]; then
  say "Existing demo database found, resetting it"
  quiet_cli supabase db reset --local --no-seed
fi

say "Applying supabase/schema.sql"
apply_file supabase/schema.sql

# Migrations run in filename (date) order, with two corrections.
#
# SKIP: already folded into schema.sql, which holds the newer superset of what
# they create. Re-running them fails on "policy ... already exists".
SKIP="
2026-07-01-allowlist-rls
2026-07-02-ingest-jobs
2026-07-03-outreach-crm
"
# AFTER: "child parent" pairs. Several same-day migrations depend on a sibling
# that sorts later alphabetically (in production they ran in the order they were
# written, not by name). Each child is applied right after its parent.
AFTER="
2026-07-13-phase0-florist-realm           2026-07-13-phase0-orders
2026-07-13-phase0-client-comms            2026-07-13-phase0-orders
2026-07-13-phase0-florist-line-items      2026-07-13-phase0-florist-realm
2026-07-14-issue-messaging                2026-07-14-order-issues
2026-07-30-admin-card-issuance-index      2026-07-30-admin-card-issuance
2026-08-05-email-events-idempotency       2026-08-05-email-events
2026-08-06-line-item-translations-variant 2026-08-06-line-item-translations
2026-08-08-conversations                  2026-08-08-sequence-enrolments
2026-08-08-ai-disclosure                  2026-08-08-conversations
2026-09-03-flow-step-enabled              2026-09-03-flow-step-timing
"
is_skipped() { printf '%s\n' "$SKIP" | grep -qx "$1"; }
is_child()   { printf '%s\n' "$AFTER" | awk '{print $1}' | grep -qx "$1"; }
children_of() { printf '%s\n' "$AFTER" | awk -v p="$1" '$2 == p {print $1}'; }
count=0
apply_migration() {
  apply_file "supabase/migrations/$1.sql"
  count=$((count + 1))
  local child
  for child in $(children_of "$1"); do apply_migration "$child"; done
}

say "Applying migrations"
for path in supabase/migrations/*.sql; do
  name="$(basename "$path" .sql)"
  if is_skipped "$name" || is_child "$name"; then continue; fi
  apply_migration "$name"
done
echo "    $count migrations applied, $(printf '%s\n' "$SKIP" | grep -c .) skipped (already in schema.sql)"

say "Loading demo partners and orders"
# Explicit order: florist-demo and multi-bouquet need the Girona city and
# partners that mock-florists creates; product-media patches line items.
for f in mock-florists florist-demo mock-orders multi-bouquet product-media; do
  apply_file "supabase/seed/2026-07-13-${f}.sql"
  echo "    $f"
done

say "Allow-listing $DEMO_EMAIL as admin"
psql_db -c "insert into allowed_emails (email, role) values ('$DEMO_EMAIL', 'admin')
            on conflict (email) do update set role = 'admin';" >/dev/null

# Read the local stack's URL and keys (the CLI prints KEY="value" lines).
status_env="$(supabase status -o env 2>/dev/null)"
env_value() { printf '%s\n' "$status_env" | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}\r\{0,1\}$/\1/p" | head -n1; }
API_URL="$(env_value API_URL)"
ANON_KEY="$(env_value ANON_KEY)"
SERVICE_ROLE_KEY="$(env_value SERVICE_ROLE_KEY)"
[ -n "$API_URL" ] && [ -n "$ANON_KEY" ] && [ -n "$SERVICE_ROLE_KEY" ] \
  || die "could not read API_URL / ANON_KEY / SERVICE_ROLE_KEY from 'supabase status -o env'."

say "Creating the demo login"
user_json="$(mktemp)"
http_code="$(curl -sS -o "$user_json" -w '%{http_code}' \
  -X POST "$API_URL/auth/v1/admin/users" \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$DEMO_EMAIL\",\"password\":\"$DEMO_PASSWORD\",\"email_confirm\":true}")" \
  || die "could not reach the local auth API at $API_URL."
case "$http_code" in
  200|201) echo "    created $DEMO_EMAIL" ;;
  422)     echo "    $DEMO_EMAIL already exists" ;;
  *)       cat "$user_json" >&2; die "creating the demo user returned HTTP $http_code." ;;
esac
rm -f "$user_json"

say "Writing dashboard/.env.local"
env_file="dashboard/.env.local"
new_env="$(cat <<EOF
# Written by scripts/local-setup.sh for the local Supabase stack. Safe to delete.
NEXT_PUBLIC_SUPABASE_URL=$API_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY

# Use a local stand-in for the Cloudflare R2 photo bucket, so no Cloudflare
# login is needed (see dashboard/next.config.mjs).
OPENNEXT_REMOTE_BINDINGS=0

# Email stays switched off: with no EMAIL_TRANSPORT every send fails closed and
# is only logged. SMS, Shopify, Airwallex, PostHog and the AI calls are likewise
# off because their keys are not set.
EMAIL_TRANSPORT=

# The client-facing "Smart design" look (dashboard/lib/brand.ts), the one the
# README shows. Remove this line for the original Facundo theme.
NEXT_PUBLIC_BRAND=smart-design
EOF
)"
if [ -f "$env_file" ] && [ "$(cat "$env_file")" = "$new_env" ]; then
  echo "    already up to date"
else
  if [ -f "$env_file" ]; then
    backup="$env_file.backup-$(date +%Y%m%d-%H%M%S)"
    cp "$env_file" "$backup"
    echo "    existing file backed up to $backup"
  fi
  printf '%s\n' "$new_env" > "$env_file"
  echo "    written"
fi

orders="$(psql_db -tAc "select count(*) from orders")"
partners="$(psql_db -tAc "select count(*) from florists")"

say "Done: $partners demo partners, $orders demo orders"
cat <<EOF

  Next:
    cd dashboard && npm install && npm run dev     # http://localhost:3001
    Sign in with $DEMO_EMAIL / $DEMO_PASSWORD

  Database:        postgresql://postgres:postgres@127.0.0.1:54322/postgres
  Stop the stack:  supabase stop
EOF
