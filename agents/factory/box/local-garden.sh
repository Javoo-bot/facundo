#!/usr/bin/env bash
# The factory agent's own garden, booted on the GitHub runner before the agent
# starts (.github/workflows/factory-execute.yml, step "Boot the local garden").
#
#   bash agents/factory/box/local-garden.sh <clone>
#
# <clone> is the agent's working clone (box/run.sh clone). This script:
#   1. installs the Supabase CLI and starts a small local stack (db, auth, rest)
#   2. applies <clone>/supabase/schema.sql, then the migrations in date order
#      (a migration that needs a later one is retried until nothing moves)
#   3. loads box/seed.sql: invented florists and orders, nothing from staging
#   4. creates the allow-listed staff user from executor.mjs LOCAL_GARDEN
#   5. writes <clone>/dashboard/.env.local, installs the dashboard and the
#      verify skill, and starts `next dev` on 3001 through the verify skill
#
# Every key here is the local stack's own throwaway key. Nothing from the real
# garden. Notes for the agent and the log go to $GARDEN_NOTES.
set -euo pipefail
clone=$(cd "${1:?usage: local-garden.sh <clone>}" && pwd)
box=$(cd "$(dirname "$0")" && pwd)
stack=${GARDEN_STACK:-$HOME/factory-garden-stack}
notes=${GARDEN_NOTES:-$clone/../garden-notes.txt}
SUPABASE_VERSION=2.121.0
EMAIL=factory-staff@example.com
PASSWORD=factory-local-garden
say() { echo "[garden] $*"; echo "$*" >> "$notes"; }
: > "$notes"

# 1. Supabase CLI + a stack with only what the dashboard needs.
if ! command -v supabase >/dev/null; then
  mkdir -p "$HOME/.local/bin"
  curl -fsSL "https://github.com/supabase/cli/releases/download/v${SUPABASE_VERSION}/supabase_linux_amd64.tar.gz" | tar -xz -C "$HOME/.local/bin" supabase
  export PATH="$HOME/.local/bin:$PATH"
fi
mkdir -p "$stack" && cd "$stack"
[ -f supabase/config.toml ] || supabase init --yes >/dev/null
sed -i 's/^project_id = .*/project_id = "factory-garden"/' supabase/config.toml
supabase start -x realtime,storage-api,imgproxy,edge-runtime,logflare,vector,supavisor,studio,postgres-meta,mailpit
eval "$(supabase status -o env | grep -E '^(API_URL|DB_URL|ANON_KEY|SERVICE_ROLE_KEY)=')"
psql_() { docker exec -i supabase_db_factory-garden psql -q -U postgres -d postgres -v ON_ERROR_STOP=1 --single-transaction "$@"; }

# 2. Schema, then migrations in date order, retried until nothing moves.
psql_ < "$clone/supabase/schema.sql" > /dev/null
left=$(cd "$clone" && ls supabase/migrations/*.sql | LC_ALL=C sort)
while :; do
  before=$(echo "$left" | wc -w) next=""
  for f in $left; do psql_ < "$clone/$f" > /dev/null 2>&1 || next="$next $f"; done
  left=$next
  [ "$(echo "$left" | wc -w)" -lt "$before" ] || break
done
for f in $left; do
  err=$(psql_ < "$clone/$f" 2>&1 | grep -m1 ERROR || true)
  case "$err" in
    *"already exists"*) say "migration $f skipped: already in schema.sql ($err)" ;;
    *) say "MIGRATION BROKEN on an empty database: $f: $err" ;;
  esac
done

# 3. Invented rows.
psql_ < "$box/seed.sql" > /dev/null

# 4. Staff user: an auth account with a password, on the allow list as admin.
curl -fsS -o /dev/null -X POST "$API_URL/auth/v1/admin/users" \
  -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"email_confirm\":true}" || say "staff user already there"
echo "insert into allowed_emails (email, role) values ('$EMAIL', 'admin') on conflict (email) do update set role = 'admin';" | psql_

# 5. The dashboard on the local stack, started by the verify skill so its
#    doctor, drive and shot know the instance.
cat > "$clone/dashboard/.env.local" <<EOF
# Written by agents/factory/box/local-garden.sh: the local garden, throwaway keys.
NEXT_PUBLIC_SUPABASE_URL=$API_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=$ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
OPENNEXT_REMOTE_BINDINGS=0
SUPABASE_MOCK_USER_PASSWORD=$PASSWORD
VERIFY_DATABASE_URL=$DB_URL
EOF
(cd "$clone/dashboard" && npm ci --no-audit --no-fund --loglevel=error)
(cd "$clone/.claude/skills/verify" && npm ci --no-audit --no-fund --loglevel=error)
# Playwright's own ffmpeg records the verify video; the runner does not ship it.
(cd "$clone/.claude/skills/verify" && node node_modules/playwright-core/cli.js install ffmpeg) \
  || say "ffmpeg install failed: verify needs VERIFY_VIDEO=0 (screenshots only)"
export NODE_OPTIONS="${NODE_OPTIONS:-} --import $(node -p 'require("url").pathToFileURL(process.argv[1]).href' "$box/verify-local.mjs")"
(cd "$clone" && node .claude/skills/verify/control.mjs launch)
code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/)
say "dashboard answered on http://localhost:3001 with HTTP $code"
