# Deploying the ingest worker to Cloudflare

The TS ingest pipeline (this package) replaces the Mac-mini Python poller. It
claims `queued` `ingest_jobs` rows (Cron), enqueues one Queue message per city,
and runs a `CityIngestWorkflow` per city. The dashboard is unchanged — it still
inserts `queued` rows and reads the jobs panel.

**Status:** implemented, typechecked, 62 unit tests passing, and verified
end-to-end locally via `wrangler dev` against real Apify/Nominatim/Anthropic/
Supabase (a real city ingested: florists scraped, enriched, emails + ecommerce
classified, cost recorded). The steps below (needing your Cloudflare account +
paid features) have **not** been run for you.

## 0. Local dev / test (no deploy)

```bash
cd ingest-worker
npm install
cp .dev.vars.example .dev.vars   # then fill in the 4 secrets (see below)
npm run test                      # 62 unit tests
npm run dev                       # local wrangler dev on :8787
# trigger a real ingest locally (DEV_TRIGGER=true in .dev.vars):
curl -X POST localhost:8787/__run -H 'content-type: application/json' \
  -d '{"country":"ES","city":"Sitges","radius":4,"limit":2}'
```

`.dev.vars` needs: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`OPENROUTER_API_KEY`, `APIFY_TOKEN`, plus `DEV_TRIGGER=true` and
`ENABLE_BROWSER_RENDER=false` for local runs. See `.dev.vars.example` for the
full list — it is the source of truth.

## 1. One-time: Cloudflare login + provisioning

```bash
npx wrangler login
# Create the queue + its dead-letter queue (names must match wrangler.jsonc):
npx wrangler queues create ingest-city-queue
npx wrangler queues create ingest-city-dlq
```

Workflows and the Durable Object are provisioned automatically on first
`deploy` (the DO via the `v1` migration in `wrangler.jsonc`).

## 2. Secrets

One-time, and NOT touched by a deploy — `wrangler deploy` leaves existing
secrets alone, which is why CI never needs them.

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put OPENROUTER_API_KEY   # NOT ANTHROPIC_API_KEY — every LLM
                                             # call goes through OpenRouter (see
                                             # src/openrouter.ts and CLAUDE.md)
npx wrangler secret put APIFY_TOKEN
```

Verify with `npx wrangler secret list`.

## 3. Deploy

**Normally you do not.** A `release-*` tag on main (see `./scripts/release.sh`
at the repo root) deploys this worker automatically via
`.github/workflows/deploy-ingest-worker.yml` — the same tag, unconditionally,
that the dashboard ships from via `deploy-v2.yml`, so the two always reach
production together. It typechecks and runs the tests first, and prints the
deployed commit in the run summary.

That workflow exists because this worker used to be the ONE thing that did not
ship on merge, with nothing in the UI to say so. On 2026-08-11 that cost two
debugging round trips in one day — most sharply when a fix merged at 20:43
against a worker last deployed at 19:51, so re-running the feature reproduced a
bug whose fix was already on `main`.

Manual deploy is still there for a hotfix or a dry run:

```bash
npm run deploy
```

Either way this deploys the Worker with its Cron trigger (every minute), the
Queue consumer, and the Workflows. Within a minute it starts claiming any
`queued` `ingest_jobs` rows the dashboard has created.

To check what is actually live: `npx wrangler deployments list` (most recent
last), or the run summary of the latest **Deploy ingest worker** action.

## 4. Cutover (decommission the Mac-mini poller)

Once a real city is confirmed ingesting on Cloudflare (watch the jobs panel, or
`wrangler tail`), stop the launchd poller on the Mac mini
(`launchctl unload ~/Library/LaunchAgents/com.facundo.ingest-poller.plist`)
so the two don't both claim jobs. Keep `ingest/` for manual/reference runs.

## 5. Browser Rendering (optional, provision-later)

Rendering of JS-shell / social pages is **off by default** (`ENABLE_BROWSER_RENDER=false`).
The pipeline is correct without it — thin pages yield honest nulls. To enable
(needs a paid plan with Browser Rendering):

1. Uncomment the `"browser": { "binding": "BROWSER" }` line in `wrangler.jsonc`.
2. Set `ENABLE_BROWSER_RENDER=true` (a `vars` entry or secret).
3. Redeploy. The `BrowserPool` Durable Object warm-pools sessions and bounds
   concurrency to `MAX_CONCURRENT_RENDERS`.

Measure the real render demand first (Phase 1 was skipped) from
`enrichment_notes` — how many pages came back thin — before sizing the pool.
See the roadmap's Browser Rendering section for the cost model.

## 6. Shopify setup (webhooks)

The worker receives Shopify order events at `POST /webhooks/shopify`
(HMAC-verified — see `src/shopify.ts`). To point a real store at it:

1. **Create a custom app** in the Shopify admin: Settings → Apps and sales
   channels → Develop apps → Create an app.
2. **Grant Admin API scopes**: `read_orders`, `write_orders`.
3. **Get an Admin API access token.** Custom apps created via the Dev
   Dashboard (Shopify's Jan-2026 replacement for the old "Develop apps"
   one-click installer) authorize like a public app: OAuth authorization-code
   grant, not a token shown once in the admin UI. `scripts/get-shopify-admin-token.mjs`
   automates the whole flow — it opens the authorize URL, catches the
   callback on a local HTTP server, verifies `state` + the callback's HMAC,
   and exchanges the code for an offline token:
   ```bash
   node scripts/get-shopify-admin-token.mjs \
     --shop x.myshopify.com \
     --client-id <client id from the app's API credentials> \
     --client-secret <client secret from the app's API credentials> \
     --set-secret   # pipes the result straight into `wrangler secret put SHOPIFY_ADMIN_TOKEN`
   ```
   One-time prerequisite Shopify won't let you skip: add the script's
   `--redirect-uri` (default `http://localhost:8945/callback`) to the app's
   **Allowed redirection URL(s)** in the Dev Dashboard first, or the authorize
   request is rejected. Re-run this any time the token is lost or rotated —
   Shopify never lets you view an existing one again, so there's no other way
   to recover it short of this flow.
4. **Set the remaining secrets** (the worker needs the webhook secret to
   verify inbound calls; `SHOPIFY_SHOP`/`SHOPIFY_ADMIN_TOKEN` additionally arm
   `reconcileMissingOrders`, the missed-webhook sweep in `src/reconcile.ts` —
   without them it's a guarded no-op):
   ```bash
   npx wrangler secret put SHOPIFY_WEBHOOK_SECRET   # the custom app's Client Secret (same value as --client-secret above)
   npx wrangler secret put SHOPIFY_SHOP              # e.g. x.myshopify.com
   ```
   The dashboard needs the same `SHOPIFY_SHOP`/`SHOPIFY_ADMIN_TOKEN` for
   order-status write-back (`lib/shopifyWriteback.ts`) — see
   `dashboard/.env.local.example`.
5. **Production hostname:** `wrangler.jsonc` intentionally has no custom
   `routes` entry — `facundo.<zone>` is already claimed by the v0.2
   dashboard worker, so this Worker's stable webhook target is just its
   `workers.dev` URL (`https://facundo-ingest-worker.<subdomain>.workers.dev`),
   which doesn't move across re-deploys as long as the Worker name stays the
   same.
6. **Register the three webhook subscriptions** once the worker is deployed:
   ```bash
   node scripts/register-shopify-webhooks.mjs \
     --shop x.myshopify.com \
     --token shpat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx \
     --url https://facundo-ingest-worker.<subdomain>.workers.dev/webhooks/shopify
   ```
   Idempotent — it lists existing subscriptions first and only creates or
   re-points what's missing/stale, so it's safe to re-run after every
   redeploy.

Both scripts' non-network logic (webhook plan decisions; OAuth-callback HMAC
verification) is unit-tested against fixtures — see
`test/register-shopify-webhooks.test.ts` and
`test/get-shopify-admin-token.test.ts`. Actually running them against the
real store is a manual step for whoever holds Shopify admin access.

## ⚠️ CPU limit on the Free plan (blocks full-city completion)

**Tested 2026-07-09 on a live deploy:** the worker geocodes, resolves keywords,
scrapes Apify (cost recorded), persists bare rows, and enriches florists with
real data (emails + ecommerce classified) — but a **full city** fails with
`Worker exceeded CPU time limit` partway through enrichment. Cheerio parses each
of a florist's pages several times, and the Workflow's enrichment steps
accumulate CPU within an invocation past the **Free plan's per-invocation CPU
cap**. This reproduces at any `MAX_CONCURRENT_ENRICHMENTS` (serial included), and
the Free plan does not allow raising the cap.

**Two ways to resolve it:**

1. **Upgrade to the Workers Paid plan** (~$5/mo) — then add
   `"limits": { "cpu_ms": 300000 }` to `wrangler.jsonc` and raise
   `MAX_CONCURRENT_ENRICHMENTS` (~10) for throughput. Simplest; the current
   architecture works as-is. This is a billing decision for the account owner.
2. **Per-florist fan-out (stays on Free, more work):** have `CityIngestWorkflow`
   enqueue one queue message *per florist* instead of enriching inline, with a
   separate consumer that enriches ONE florist per invocation (fresh CPU budget
   each) and a completion check that finishes the job when all florists are done.
   Most florists should fit the Free CPU cap individually; heavy sites may still
   need render/page caps. This is a scoped follow-up, not yet implemented.

Everything up to and including per-florist enrichment is verified working on
production Cloudflare; only full-city *completion* is gated on one of the above.

## Known caveats

- **Local `wrangler dev` runs enrichment steps largely serialized** and is much
  slower than production Workflows (which parallelize the per-florist steps).
  Judge throughput on a real deploy, not local dev.
- A single florist that hangs (slow site / LLM) is dropped to a
  best-effort "failed enrichment" row after `ENRICH_FLORIST_TIMEOUT_MS` (90s)
  so it can't stall the city — mirrors the Python pipeline's per-florist
  isolation.
- Cron minimum interval is 60s, so job pickup latency is up to ~1 min (vs. the
  poller's seconds). A future dashboard→Queue nudge can remove that.
