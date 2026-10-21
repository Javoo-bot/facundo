#!/usr/bin/env bash
#
# Re-run the Shopify Admin API OAuth authorization-code grant (needed once when
# the app's requested scopes change — Shopify never applies a scope change to
# an existing token, only to a fresh authorize/consent). Automates everything
# EXCEPT the merchant's actual "Install app" click in the browser — that's
# Shopify's own consent screen and has to stay a real human action.
#
# Usage (run from anywhere; reads client id/secret from ../.dev.local):
#   ./scripts/shopify-reauth.sh "read_orders,write_orders,read_products,..."
#
# Prints an authorize URL. Open it, click "Install app", then paste the full
# resulting https://example.com/shopify/callback?... URL back when prompted.
# The script verifies state+HMAC, exchanges the code, confirms the granted
# scopes via /admin/oauth/access_scopes.json, then writes the new
# SHOPIFY_ADMIN_TOKEN to every local file AND every deployed Worker
# (facundo-dashboard-staging, facundo-dashboard-v2, facundo-ingest-worker)
# in one pass. Requires `npx wrangler login` already done for the deploy step.
set -euo pipefail

SCOPES="${1:?Usage: $0 \"read_orders,write_orders,...\"}"
SHOP="your-store.myshopify.com"
# Must match an entry in the app's Configuration → URLs → Allowed redirection
# URL(s) EXACTLY, or authorize fails with "redirect_uri is not whitelisted".
# This is the one the app already allows (docs/SHOPIFY-GO-LIVE.md §1a); nothing
# listens on that port here, so the browser will show a connection error after
# you consent — that's expected, the code is in the address bar. Override with
# a second argument if the app's allow-list changes.
REDIRECT_URI="${2:-http://localhost:8945/callback}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The main checkout, which differs from REPO_ROOT only when this runs inside a
# git worktree. Worktrees don't carry untracked files, so the gitignored
# .dev.local (and .env.local) live only there — read credentials from it, and
# write the new token to BOTH roots so neither checkout is left on a stale one.
MAIN_ROOT=$(cd "$REPO_ROOT" && git rev-parse --git-common-dir 2>/dev/null)
case "$MAIN_ROOT" in
  "") MAIN_ROOT="$REPO_ROOT" ;;                       # not a git checkout at all
  /*) MAIN_ROOT="$(dirname "$MAIN_ROOT")" ;;          # absolute: .../facundo/.git
  *)  MAIN_ROOT="$REPO_ROOT" ;;                       # relative ".git" — same root
esac

DEV_LOCAL="$REPO_ROOT/.dev.local"
[ -f "$DEV_LOCAL" ] || DEV_LOCAL="$MAIN_ROOT/.dev.local"
[ -f "$DEV_LOCAL" ] || { echo "error: .dev.local not found in $REPO_ROOT or $MAIN_ROOT (need SHOPIFY_CLIENT_ID/SHOPIFY_SECRET)"; exit 1; }
echo "✓ credentials from $DEV_LOCAL"

CLIENT_ID=$(grep -m1 '^SHOPIFY_CLIENT_ID=' "$DEV_LOCAL" | cut -d= -f2-)
CLIENT_SECRET=$(grep -m1 '^SHOPIFY_SECRET=' "$DEV_LOCAL" | cut -d= -f2-)
[ -n "$CLIENT_ID" ] && [ -n "$CLIENT_SECRET" ] || { echo "error: SHOPIFY_CLIENT_ID/SHOPIFY_SECRET missing from $DEV_LOCAL"; exit 1; }

STATE=$(openssl rand -hex 16)

echo "→ Open this URL, sign in as the store owner, and click \"Install app\":"
echo
echo "https://${SHOP}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${SCOPES}&redirect_uri=${REDIRECT_URI}&state=${STATE}"
echo
echo "  (the page will fail to load — nothing listens on $REDIRECT_URI. That's fine.)"
echo
echo "→ Paste the FULL resulting URL from your browser's address bar below (contains code=...):"
read -r CALLBACK_URL

# Parse the callback query string.
QUERY="${CALLBACK_URL#*\?}"
get_param() { echo "$QUERY" | tr '&' '\n' | grep "^$1=" | cut -d= -f2-; }
CODE=$(get_param code)
HMAC_RECEIVED=$(get_param hmac)
HOST_B64=$(get_param host)
SHOP_RECEIVED=$(get_param shop)
STATE_RECEIVED=$(get_param state)
TIMESTAMP=$(get_param timestamp)

[ -n "$CODE" ] || { echo "error: no code= found in the pasted URL"; exit 1; }

if [ "$STATE_RECEIVED" != "$STATE" ]; then
  echo "error: state mismatch — this callback doesn't match the URL just issued. Aborting."
  exit 1
fi

MESSAGE="code=${CODE}&host=${HOST_B64}&shop=${SHOP_RECEIVED}&state=${STATE_RECEIVED}&timestamp=${TIMESTAMP}"
COMPUTED_HMAC=$(printf '%s' "$MESSAGE" | openssl dgst -sha256 -hmac "$CLIENT_SECRET" | sed 's/^.* //')
if [ "$COMPUTED_HMAC" != "$HMAC_RECEIVED" ]; then
  echo "error: HMAC mismatch — this callback may be forged/tampered. Aborting."
  exit 1
fi
echo "✓ state + HMAC verified — genuine callback from Shopify"

TOKEN_JSON=$(curl -s -X POST "https://${SHOP}/admin/oauth/access_token" \
  -H "Content-Type: application/json" \
  -d "{\"client_id\":\"${CLIENT_ID}\",\"client_secret\":\"${CLIENT_SECRET}\",\"code\":\"${CODE}\"}")
TOKEN=$(echo "$TOKEN_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('access_token',''))")
[ -n "$TOKEN" ] || { echo "error: token exchange failed: $TOKEN_JSON"; exit 1; }
echo "✓ exchanged code for an access token"

GRANTED=$(curl -s "https://${SHOP}/admin/oauth/access_scopes.json" -H "X-Shopify-Access-Token: ${TOKEN}" \
  | python3 -c "import json,sys; print(','.join(s['handle'] for s in json.load(sys.stdin).get('access_scopes',[])))")
echo "✓ granted scopes: $GRANTED"

# Write to every local file that carries SHOPIFY_ADMIN_TOKEN, in both roots
# (identical paths outside a worktree — the `seen` guard keeps that a no-op).
seen=""
for f in \
  "$REPO_ROOT/dashboard/.dev.vars" \
  "$REPO_ROOT/ingest-worker/.dev.vars" \
  "$REPO_ROOT/dashboard/.env.local" \
  "$MAIN_ROOT/dashboard/.dev.vars" \
  "$MAIN_ROOT/ingest-worker/.dev.vars" \
  "$MAIN_ROOT/dashboard/.env.local"
do
  [ -f "$f" ] || continue
  case "$seen" in *"|$f|"*) continue ;; esac
  seen="$seen|$f|"
  if grep -q '^SHOPIFY_ADMIN_TOKEN=' "$f"; then
    # Portable in-place edit (no GNU/BSD sed flag mismatch).
    tmp=$(mktemp)
    sed "s|^SHOPIFY_ADMIN_TOKEN=.*|SHOPIFY_ADMIN_TOKEN=${TOKEN}|" "$f" > "$tmp" && mv "$tmp" "$f"
  else
    echo "SHOPIFY_ADMIN_TOKEN=${TOKEN}" >> "$f"
  fi
  echo "✓ updated $f"
done

echo "→ pushing to deployed Workers (wrangler secret put)…"
cd "$REPO_ROOT/dashboard"
for WORKER in facundo-dashboard-staging facundo-dashboard-v2 facundo-ingest-worker; do
  printf '%s' "$TOKEN" | npx wrangler secret put SHOPIFY_ADMIN_TOKEN --name "$WORKER"
done

echo
echo "Done. SHOPIFY_ADMIN_TOKEN rotated everywhere with scopes: $GRANTED"
