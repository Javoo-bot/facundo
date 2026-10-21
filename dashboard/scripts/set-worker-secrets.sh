#!/usr/bin/env bash
#
# Set the Cloudflare Worker runtime secrets for the Facundo dashboard.
#
# Secret values are read from dashboard/.env.local (v2) or
# dashboard/.env.staging.local (staging, when present) and piped straight into
# `wrangler secret put` — they never appear on a command line, in `ps`, or in
# shell history. Non-secret config (the public base URLs) is set from fixed
# values. The OUTBOX/PROOF gate secret is generated with `openssl rand`.
#
# See dashboard/DEPLOY.md §2 for what each secret unlocks.
#
# NOT here: NEXT_PUBLIC_* vars (PostHog, Supabase URL/anon key, VAPID public key,
# INGEST_MODE). They are inlined into the client bundle by `next build`, so
# `wrangler secret put` has no effect on them whatsoever — the compiled bundle
# would still read `undefined`. Their home is dashboard/.env.local for local
# builds (Next loads it automatically) and GitHub Actions secrets for CI. If you
# came here to add NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN, put it in .env.local
# instead — see DEPLOY.md §3/§3a.
#
# Usage (run from dashboard/, after `npx wrangler login`):
#   ./scripts/set-worker-secrets.sh staging
#   ./scripts/set-worker-secrets.sh v2
#   ./scripts/set-worker-secrets.sh staging --ingest   # also set the ingest worker's cron secrets
#
# Re-runnable: `wrangler secret put` overwrites, so running again just updates.
# To reuse a specific gate secret instead of generating one, export it first:
#   OUTBOX_SECRET_OVERRIDE=<hex> ./scripts/set-worker-secrets.sh v2 --ingest
#
set -euo pipefail

ENV="${1:-}"
INGEST=""
AIRWALLEX_ONLY=""
for a in "${@:2}"; do
  case "$a" in
    --ingest)         INGEST=1 ;;
    --airwallex-only) AIRWALLEX_ONLY=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done
# --airwallex-only exists because a full run REGENERATES OUTBOX_SECRET/PROOF_SECRET.
# The staging Worker shares OUTBOX_SECRET with the single facundo-ingest-worker,
# so regenerating it here desyncs the cron; re-pairing via --ingest would then point
# that one shared worker away from production. Rotating just the Airwallex keys
# avoids touching either.

# BASE       — self/API origin, used for the ingest worker's DASHBOARD_URL cron
#              target (host-agnostic /api/*); must be a LIVE host.
# FLORIST_/BACKOFFICE_BASE_URL — audience-scoped EMAIL-link bases (lib/emailLinks.ts).
#              The two production hosts are gated (a /cx link 404s on the florist
#              host, a /florist/… link 404s on the backoffice host), so one base
#              can't serve both. Staging serves both surfaces on one un-split host.
case "$ENV" in
  staging)
    WORKER="facundo-dashboard-staging"; BASE="https://facundo-staging.example.org"
    FLORIST_BASE_URL="$BASE"; BACKOFFICE_BASE_URL="$BASE"
    # Staging must NEVER get the production Airwallex account — issuing a card
    # there moves real money. .env.local holds both sets side by side:
    # AIRWALLEX_* (production, api.airwallex.com) and SANDBOX_AIRWALLEX_*
    # (demo, api-demo.airwallex.com). Staging reads the SANDBOX_ ones.
    AWX_PREFIX="SANDBOX_" ;;
  v2)
    WORKER="facundo-dashboard-v2";       BASE="https://facundo.example.org"
    FLORIST_BASE_URL="https://florist.fc.example.net"
    BACKOFFICE_BASE_URL="https://bo.fc.example.net"
    AWX_PREFIX="" ;;
  *) echo "usage: $0 <staging|v2> [--ingest]"; exit 1 ;;
esac

# Value lookup is an ORDERED overlay, first file to define a key wins.
# For staging, .env.staging.local shadows .env.local — critically for
# SUPABASE_SERVICE_ROLE_KEY, where .env.local holds the PRODUCTION key
# (ref your-project-ref). Without the overlay this script would point the
# staging Worker straight at the production database.
case "$ENV" in
  staging) ENV_FILES=".env.staging.local .env.local" ;;
  *)       ENV_FILES=".env.local" ;;
esac
ENV_FILE="${ENV_FILES%% *}"          # first file, for messages
[ -f ".env.local" ] || { echo "error: .env.local not found — run this from dashboard/"; exit 1; }
for f in $ENV_FILES; do
  [ -f "$f" ] || { echo "error: $f not found (needed for $ENV) — run this from dashboard/"; exit 1; }
done
echo "→ reading values from: $ENV_FILES"

if [ "$ENV" = "staging" ] && [ "$ENV_FILE" = ".env.local" ]; then
  echo "error: staging secrets must come from .env.staging.local, not production .env.local"
  echo "       Create .env.staging.local with STAGING Supabase values first."
  exit 1
fi

if [ "$ENV" = "staging" ] && [ -f ".env.local" ]; then
  prod_url=$(grep -m1 '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2- || true)
  staging_url=$(grep -m1 '^NEXT_PUBLIC_SUPABASE_URL=' "$ENV_FILE" | cut -d= -f2- || true)
  prod_url=$(printf '%s' "$prod_url" | sed -e 's/[[:space:]][[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  staging_url=$(printf '%s' "$staging_url" | sed -e 's/[[:space:]][[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  if [ -n "$prod_url" ] && [ "$prod_url" = "$staging_url" ]; then
    echo "error: .env.staging.local points at the same Supabase URL as production .env.local"
    exit 1
  fi
fi

echo "→ setting secrets on $WORKER   (florist links: $FLORIST_BASE_URL · staff links: $BACKOFFICE_BASE_URL)"

# Pipe a value into a worker secret (never echoed).
put() { printf '%s' "$2" | npx wrangler secret put "$1" --name "$WORKER"; }

# Read KEY from .env.local, set it, or skip if absent. Strips a trailing inline
# `  # comment` (several lines in .env.local carry one — dotenv drops them, so a
# naive read here would have shipped the comment text as part of the secret),
# surrounding whitespace, and surrounding quotes.
readenv() {
  local k="$1" f v=""
  for f in $ENV_FILES; do
    v=$(grep -m1 "^${k}=" "$f" 2>/dev/null | cut -d= -f2- || true)
    v=$(printf '%s' "$v" | sed -e 's/[[:space:]][[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    [ -n "$v" ] && break
  done
  printf '%s' "$v"
}

fromenv() {
  local v; v=$(readenv "$1")
  if [ -n "$v" ]; then put "$1" "$v"; else echo "· skip $1 (not in $ENV_FILES — set manually)"; fi
}

# Push worker secret $1 using the value of ${AWX_PREFIX}$1 from .env.local, so
# staging draws the demo Airwallex account and v2 the production one.
fromenv_awx() {
  local src="${AWX_PREFIX}$1" v; v=$(readenv "$src")
  if [ -n "$v" ]; then put "$1" "$v"; echo "  ($1 ← $src)"
  else echo "· skip $1 (no $src in $ENV_FILES — set manually)"; fi
}

# 1. Secrets sourced from .env.local (values never printed).
if [ -z "$AIRWALLEX_ONLY" ]; then
for k in \
  SUPABASE_SERVICE_ROLE_KEY EMAIL_TRANSPORT \
  ONGAGE_LIST_ID ONGAGE_USERNAME ONGAGE_PASSWORD ONGAGE_ACCOUNT_CODE ONGAGE_SENDING_CONNECTION_ID \
  RESEND_API_KEY RESEND_FROM \
  VAPID_PRIVATE_KEY VAPID_SUBJECT OPENROUTER_API_KEY \
  SHOPIFY_SHOP SHOPIFY_ADMIN_TOKEN \
  GOOGLE_MAPS_API_KEY OPENROUTER_API_KEY \
  TELNYX_API_KEY TELNYX_MESSAGING_PROFILE_ID TELNYX_SENDER_ID
do
  fromenv "$k"
done
fi

# Guard: the service-role JWT embeds its project ref. Decode it (payload only,
# never the signature) and refuse if staging would be handed the prod database.
SRK=$(readenv SUPABASE_SERVICE_ROLE_KEY)
SRK_REF=$(printf '%s' "$SRK" | cut -d. -f2 | python3 -c "
import sys,base64,json
t=sys.stdin.read().strip()
try: print(json.loads(base64.urlsafe_b64decode(t+'='*(-len(t)%4))).get('ref',''))
except Exception: print('')" 2>/dev/null)
case "$ENV" in
  staging) WANT_REF="your-staging-project-ref" ;;
  v2)      WANT_REF="your-project-ref" ;;
esac
if [ -z "$AIRWALLEX_ONLY" ] && [ -n "$SRK_REF" ] && [ "$SRK_REF" != "$WANT_REF" ]; then
  echo "ABORT: SUPABASE_SERVICE_ROLE_KEY is for project '$SRK_REF', but $ENV expects '$WANT_REF'." >&2
  exit 1
fi
echo "  (supabase project ref for $ENV: $SRK_REF)"

# 1b. Airwallex, resolved through AWX_PREFIX (see the env case above).
for k in AIRWALLEX_CLIENT_ID AIRWALLEX_API_KEY AIRWALLEX_BASE; do fromenv_awx "$k"; done

# Hard stop: staging pointing at the production Airwallex host means a payout
# there would issue a REAL card. Refuse rather than deploy that combination.
AWX_API=$(readenv "${AWX_PREFIX}AIRWALLEX_BASE")
if [ "$ENV" = "staging" ]; then
  case "${AWX_API:-https://api-demo.airwallex.com}" in
    *api-demo.airwallex.com*) ;;
    *) echo "ABORT: staging resolved AIRWALLEX_BASE='$AWX_API', which is not the demo host." >&2
       echo "       Set SANDBOX_AIRWALLEX_BASE=https://api-demo.airwallex.com in $ENV_FILE." >&2
       exit 1 ;;
  esac
fi

# 2. One shared secret gates the outbox/wave endpoints AND signs the proof-photo
#    link. Kept in $SECRET so --ingest can reuse the same value below.
SECRET="${OUTBOX_SECRET_OVERRIDE:-$(openssl rand -hex 32)}"
if [ -z "$AIRWALLEX_ONLY" ]; then
put OUTBOX_SECRET "$SECRET"
put PROOF_SECRET  "$SECRET"
fi

# 3. Fixed public config (not secrets, but the code reads them via process.env).
#    Email-link bases (lib/emailLinks.ts): APP_BASE_URL = florist-PWA + customer +
#    host-agnostic links (offer email, proof photo, logo); BACKOFFICE_BASE_URL =
#    staff links (/cx, /orders/…). Each must resolve on its gated host.
if [ -z "$AIRWALLEX_ONLY" ]; then
put APP_BASE_URL        "$FLORIST_BASE_URL"
put BACKOFFICE_BASE_URL "$BACKOFFICE_BASE_URL"
fi

# AIRWALLEX_APP_BASE is the AIRWALLEX CONSOLE host that card deep-links point at
# (lib/airwallex/links.ts) — NOT our dashboard. Setting it to $BASE made the
# "View card in Airwallex" link resolve to our own domain → 404. Derive it from
# the API host we just set: sandbox (api-demo) → demo.airwallex.com, else
# www.airwallex.com. Re-running overwrites any stale bad value on the worker.
case "$AWX_API" in
  *demo*|"") AIRWALLEX_APP="https://demo.airwallex.com" ;;
  *)         AIRWALLEX_APP="https://www.airwallex.com" ;;
esac
put AIRWALLEX_APP_BASE "$AIRWALLEX_APP"

# 4. Optional: the single ingest worker drives the timed cron. It needs the SAME
#    OUTBOX_SECRET and a DASHBOARD_URL pointing at this environment. NOTE: there
#    is only one ingest worker, so whichever env you run --ingest for last is the
#    one its cron drives.
if [ -n "$INGEST" ] && [ -z "$AIRWALLEX_ONLY" ]; then
  echo "→ setting cron secrets on facundo-ingest-worker (drives $BASE)"
  printf '%s' "$SECRET" | npx wrangler secret put OUTBOX_SECRET --name facundo-ingest-worker
  printf '%s' "$BASE"   | npx wrangler secret put DASHBOARD_URL --name facundo-ingest-worker

  # The daily automation digest (ingest-worker/src/dailyDigest.ts) sends through
  # Resend from inside the worker, so it needs its OWN copy of the key: a
  # Cloudflare secret belongs to one Worker and cannot be read back or shared,
  # so the dashboard's copy is no use to it. Until this is set the digest is a
  # guarded no-op and every cron tick skips with "resend-key-unset", which is
  # the intended safe default rather than a failure.
  #
  # Only for v2. The staging ingest worker deliberately does NOT get this: it
  # runs the same every-minute cron against the staging database, so a key there
  # would produce a second, staging-numbered digest to the same inbox.
  if [ "$ENV" = "v2" ]; then
    printf '%s' "$RESEND_API_KEY" | npx wrangler secret put RESEND_API_KEY --name facundo-ingest-worker
    # Optional. Unset, the digest falls back to DEFAULT_RECIPIENTS in
    # dailyDigest.ts. Setting it here overrides the list with no deploy.
    if [ -n "${DIGEST_TO:-}" ]; then
      printf '%s' "$DIGEST_TO" | npx wrangler secret put DIGEST_TO --name facundo-ingest-worker
    fi
  fi
fi

echo "✓ done. Verify:  npx wrangler secret list --name $WORKER"
