# Deploying the dashboard to Cloudflare Workers (staging)

This deploys **dashboard/ only** (via OpenNext for Cloudflare) to a Cloudflare
Workers staging environment. The Python `ingest/` CLI stays local-only — see
"Ingest is local-only" below.

All commands below are run from `dashboard/`. None of this has been run for
you; it needs your own Cloudflare login and account.

## 0. Why OpenNext, not next-on-pages

Six API routes (`app/api/**/route.ts`) declare `export const runtime =
"nodejs"` (they use `node:child_process`, `node:crypto`, etc.).
`@cloudflare/next-on-pages` is edge-only and would reject those routes.
`@opennextjs/cloudflare` runs Next on Workers with the `nodejs_compat`
compatibility flag, which supports them — that's why this repo uses it.

## 1. One-time: Cloudflare login

```bash
npx wrangler login
```

Opens a browser to authorize wrangler against your Cloudflare account.

**Before the first production deploy** — a `release-*` tag on main auto-deploys
via `.github/workflows/deploy-v2.yml` (see `./scripts/release.sh` at the repo
root) — apply
`supabase/migrations/2026-07-03-pipeline-lifecycle.sql` to the shared Supabase
project (SQL editor or CLI). It adds the `lifecycle_stage` column and the
`florist_notes`/`florist_meetings` tables that the pipeline UI and the
`/api/florists/{stage,note,meeting}` routes depend on. It's additive and
idempotent, so it's safe to run against staging even if it's already been
applied.

## 2. Set the runtime secrets

**Quick way — the helper script.** `scripts/set-worker-secrets.sh` does the whole
list below in one go: it reads each secret from `dashboard/.env.local` for v2 or
from `dashboard/.env.staging.local` for staging and pipes it into `wrangler secret
put` (values never touch the command line or shell history), sets the fixed public
URLs, and generates the `OUTBOX_SECRET`/`PROOF_SECRET` gate. Run from `dashboard/`
after `npx wrangler login`:

```bash
./scripts/set-worker-secrets.sh staging            # or: v2
./scripts/set-worker-secrets.sh staging --ingest   # also set the ingest worker's cron secrets
```

For staging, the helper deliberately refuses to read `.env.local`, because v0.2 is
production and `.env.local` usually points at the production Supabase project. Create
`.env.staging.local` with the staging Supabase URL, anon key, and service-role key
before running it. Anything missing from the selected env file prints `· skip …` so
you can set it by hand.
Verify with `npx wrangler secret list --name facundo-dashboard-staging`. The
manual, secret-by-secret breakdown (and what each one unlocks) follows.

`SUPABASE_SERVICE_ROLE_KEY` and the email secrets (`EMAIL_TRANSPORT` plus
whichever of `ONGAGE_*` / `RESEND_*` it selects) are read via `process.env.X`
by existing route handlers. `wrangler.jsonc` sets `compatibility_flags` to
include `nodejs_compat_populate_process_env` (default-on anyway for our
`compatibility_date`), so anything set via `wrangler secret put` becomes
available as `process.env.X` inside the Worker automatically — no code
changes needed.

Run each of these and paste the value when prompted (values come from
`dashboard/.env.local`, which you already have — don't paste them into shell
history or commit them anywhere). For the **staging** worker, add
`--name facundo-dashboard-staging` to each (shown below), or run from a
staging checkout where `wrangler.jsonc` already carries that name.

Check what's already set at any time:

```bash
npx wrangler secret list --name facundo-dashboard-staging
```

### 2a. Required — core app (auth, data, outreach email)

Outbound email is dual-transport (`EMAIL_TRANSPORT`, `lib/emailTransport.ts`) —
**staging runs Ongage**, **v0.2/production runs Resend** (Resend has a working
delivery/open/click webhook that Ongage doesn't; see `lib/lifecycle.ts`'s
`x-email-delivery-feedback-ongage` entry). `EMAIL_TRANSPORT` has no default —
sendEmail() fails every send closed (logged) if it's unset, or if it's set to a
transport whose own secrets below aren't configured. It never silently falls
back to the other transport.

**Staging** (`--name facundo-dashboard-staging`):

```bash
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --name facundo-dashboard-staging
npx wrangler secret put EMAIL_TRANSPORT --name facundo-dashboard-staging          # value: ongage
npx wrangler secret put ONGAGE_LIST_ID --name facundo-dashboard-staging
npx wrangler secret put ONGAGE_USERNAME --name facundo-dashboard-staging
npx wrangler secret put ONGAGE_PASSWORD --name facundo-dashboard-staging
npx wrangler secret put ONGAGE_ACCOUNT_CODE --name facundo-dashboard-staging
npx wrangler secret put ONGAGE_SENDING_CONNECTION_ID --name facundo-dashboard-staging
# Optional: ONGAGE_FROM (default "Facundo <noreply@fc.example.com>" — must stay on the connection's domain)
```

**v0.2 / production** (`--name facundo-dashboard-v2`):

```bash
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --name facundo-dashboard-v2
npx wrangler secret put EMAIL_TRANSPORT --name facundo-dashboard-v2               # value: resend
npx wrangler secret put RESEND_API_KEY --name facundo-dashboard-v2                # Resend dashboard → API Keys
npx wrangler secret put RESEND_FROM --name facundo-dashboard-v2                   # value: Facundo <noreply@fc.example.net>
```

`RESEND_FROM` must stay on the Resend account's verified domain
(`fc.example.net` — DKIM/SPF/click-tracking CNAME all verified there; the
account's only unverified DNS record is the inbound-receiving MX, which only
affects the dormant reply-threading-via-inbound feature, not sending or
tracking). If unset, `lib/emailFrom.ts` falls back to
`Facundo <noreply@fc.example.net>`.

### 2b. Order-loop features (Phase-0)

Generate the two app-owned secrets with `openssl rand -hex 32`. Use the **same**
`OUTBOX_SECRET` value on the ingest worker too (see 2e) — it's a shared HMAC/gate.

```bash
# arms the offer-wave auto-advance + payout-retry cron endpoints
npx wrangler secret put OUTBOX_SECRET --name facundo-dashboard-staging
# delivered-photo customer email — signs the time-limited proof link
npx wrangler secret put PROOF_SECRET --name facundo-dashboard-staging      # or reuse OUTBOX_SECRET's value
# Email-link bases (see lib/emailLinks.ts). Florist emails link to the florist
# host, staff emails to the backoffice host. In PRODUCTION both can be omitted —
# they default to https://florist.fc.example.net and https://bo.fc.example.net.
# Staging serves BOTH surfaces on one un-split host, so point BOTH at it:
npx wrangler secret put APP_BASE_URL --name facundo-dashboard-staging          # value: https://facundo-staging.example.org
npx wrangler secret put BACKOFFICE_BASE_URL --name facundo-dashboard-staging   # value: https://facundo-staging.example.org
# missing-webhook reconciliation sweep + Shopify write-back
# (write-back is ALSO gated by the Settings → External services safeguard, default OFF)
npx wrangler secret put SHOPIFY_SHOP --name facundo-dashboard-staging          # e.g. yourshop.myshopify.com
npx wrangler secret put SHOPIFY_ADMIN_TOKEN --name facundo-dashboard-staging
```

### 2c. Payouts (Airwallex sandbox)

Without these, the accept/deliver payout legs fail — best-effort, so they don't
block the order flow, but no virtual cards are issued.

```bash
npx wrangler secret put AIRWALLEX_CLIENT_ID --name facundo-dashboard-staging
npx wrangler secret put AIRWALLEX_API_KEY --name facundo-dashboard-staging
npx wrangler secret put AIRWALLEX_BASE --name facundo-dashboard-staging          # value: https://api-demo.airwallex.com (sandbox)
npx wrangler secret put AIRWALLEX_APP_BASE --name facundo-dashboard-staging      # Airwallex CONSOLE host for card deep-links (sandbox: https://demo.airwallex.com) — NOT our dashboard URL. Optional: unset → derived from AIRWALLEX_BASE.
```

Cards are issued directly to Facundo (`issue_to: "ORGANISATION"`, no cardholder) —
see `lib/airwallex/cards.ts`'s header comment. No cardholder secrets needed.

**`AIRWALLEX_WEBHOOK_SECRET` is REQUIRED, not optional — do this before going live.**
`lib/airwallex/webhookVerify.ts` returns `{ ok: false, reason: "no-secret-configured" }`
whenever this is unset, and `app/api/webhooks/airwallex/route.ts` turns that into a 401
for **every single delivery**, with no exception. There is no degraded-but-working mode:
an unset secret means Airwallex's authorization/clearing/decline/dispute events never
reach us at all. Confirmed in production on 2026-09-04: `airwallex_events` had zero rows
ever, and all 38 card-rail payouts since 2026-08-01 sat at `status='issued'` with
`spent_amount`/`settled_at` permanently null — while Airwallex's own records showed 21 of
those 38 cards had real, several already-cleared authorizations. The books were wrong and
nothing on our side could tell. (As of this fix, a rejected delivery at least logs to
`external_ops` — see `webhook_in`/`airwallex` rows — so this failure mode is now visible
instead of silent; but visible-and-broken still means broken. Set the secret.)

Two steps, not one — the webhook endpoint also has to actually be registered:

1. In the Airwallex console (Developer → Webhooks, on the SAME base you set
   `AIRWALLEX_BASE`/`AIRWALLEX_APP_BASE` to — sandbox and production are separate
   registrations), add an endpoint pointing at
   `https://<this-deploy's-host>/api/webhooks/airwallex` (production: `bo.fc.example.net`)
   subscribed to at least `issuing.transaction.succeeded`, `issuing.transaction.failed`,
   `issuing.reissue.succeeded`, `issuing.transaction_dispute.modified`, and
   `issuing.transaction_dispute.accepted` (see `lib/airwallex/webhookMap.ts` for the
   full list this reads).
2. Copy the signing secret Airwallex shows you for that endpoint and set it here:

```bash
npx wrangler secret put AIRWALLEX_WEBHOOK_SECRET --name facundo-dashboard-staging
```

After setting it, confirm deliveries are actually landing — the backoffice's SYSTEM →
External operations view (or a direct query on `external_ops` where
`provider='airwallex' and operation='webhook_in'`) should start showing `ok:true` rows
within minutes of any card being spent. A run of `ok:false` rows there means the secret
or the registered URL is wrong, not that Airwallex isn't sending anything.

Optional Airwallex tuning (have sensible defaults if unset): `AIRWALLEX_ALLOWED_MCC`,
`AIRWALLEX_CREATED_BY`, `AIRWALLEX_PROGRAM_PURPOSE`, `AIRWALLEX_PROGRAM_TYPE`.

### 2d. Florist SMS (Telnyx, optional)

Without these, `lib/sms.ts::sendSms` fails closed (logs to `external_ops` +
`communications` and returns `{ ok: false }`) — no crash, no SMS sent.

```bash
# A scoped API key (Bearer auth), not an account-master credential — revocable
# and rotatable on its own. Telnyx portal → API Keys.
npx wrangler secret put TELNYX_API_KEY --name facundo-dashboard-staging
npx wrangler secret put TELNYX_MESSAGING_PROFILE_ID --name facundo-dashboard-staging
# The alphanumeric brand sender the florist sees, e.g. "Facundo". Telnyx
# requires an explicit `from` per send, so this ONE sender is used for every
# destination — fine for ES/FR/IT/DE, but the US/Canada would need a registered
# number instead (not built). Alphanumeric IDs need pre-registration in several
# EU countries; that has lead time, so start it before you need it.
npx wrangler secret put TELNYX_SENDER_ID --name facundo-dashboard-staging
```

### 2e. Optional

```bash
# web-push to florists (the public key is already a build-time GH secret)
npx wrangler secret put VAPID_PRIVATE_KEY --name facundo-dashboard-staging
npx wrangler secret put VAPID_SUBJECT --name facundo-dashboard-staging     # value: mailto:you@example.com
# only powers the "generate outreach draft" button
npx wrangler secret put ANTHROPIC_API_KEY --name facundo-dashboard-staging
```

### 2f. The cron lives on the ingest worker, not the dashboard

`OUTBOX_SECRET` on the dashboard only *gates* the `/api/outbox/drain`,
`/api/orders/waves/tick`, `/api/cx/alert-sweep`, `/api/payouts/held-sweep`, and
`/api/payouts/reconcile` endpoints (the CX one pages staff by email + web-push
when SLA-breaching work goes unattended — see `dashboard/lib/cxAlerts.ts`; the
last reads live Airwallex state and repairs card-rail payouts a dropped
webhook left stale — see `dashboard/lib/airwallex/reconcile.ts`; both are
self-throttled server-side, so the cron can poke them every minute for free).
The thing that *calls* them every minute is
the **ingest** worker (`facundo-ingest-worker`). For the timed auto-advance to
drive staging, that worker needs the **same** `OUTBOX_SECRET` plus a
`DASHBOARD_URL` pointing at staging:

```bash
cd ../ingest-worker
npx wrangler secret put OUTBOX_SECRET   # SAME value as the dashboard's
npx wrangler secret put DASHBOARD_URL   # value: https://facundo-staging.example.org
```

Caveat: there is a **single** ingest worker (no `-staging` variant), and its
`DASHBOARD_URL` defaults to the v2 domain — so pointing it at staging moves the
cron off v2. For staging testing you can instead trigger the three endpoints by
hand with the shared secret, e.g.
`curl -X POST https://facundo-staging.example.org/api/orders/waves/tick -H "x-outbox-secret: <value>"`.
Everything except the *timed* auto-advance works on staging without any of this
(manual offer/approve/deliver all function).

`ALLOWED_EMAILS` is **seed-only** now — it is not read at runtime. The
`allowed_emails` table (edited from `/settings` in the dashboard, or seeded
directly in Supabase) is the single runtime source of truth for who can sign
in and call protected routes. You don't need to set `ALLOWED_EMAILS` as a
Worker secret for this deployment; it only matters when first seeding the
table via the ingest CLI or SQL editor.

`INGEST_MODE=queue` is **not** a secret for this environment — it's already
set as a plain `vars` entry in `wrangler.jsonc` and needs no action from you.
It makes `POST /api/ingest` enqueue a job for the Mac-mini poller (see §6)
instead of spawning a Python process that doesn't exist on Workers, and makes
`POST /api/keywords` fail fast (keyword derivation happens on the Mac mini).

## 3. Build-time vars (the `NEXT_PUBLIC_*` ones)

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`NEXT_PUBLIC_INGEST_MODE`, and `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` /
`NEXT_PUBLIC_POSTHOG_HOST` are inlined into the client bundle by `next build` at
**build time**, not read at runtime — `wrangler secret put` would not help here
(the compiled bundle would still reference `undefined`).
`NEXT_PUBLIC_INGEST_MODE=queue` is what tells the client to enqueue jobs
(skip the keyword prefetch) rather than expect a local CLI spawn — set it in
`dashboard/.env.local` alongside the two Supabase values.

Since `npm run cf:deploy` builds locally (not via Cloudflare's git-connected
Workers Builds CI), Next.js's built-in `.env.local` loading handles this
automatically: `dashboard/.env.local` already has these values, and `next
build` reads it the same way `next dev` does. **No extra step needed** as
long as you build from a checkout that still has `.env.local` in place (with
`NEXT_PUBLIC_INGEST_MODE=queue` present).

(If you ever move this to Cloudflare's git-connected Workers Builds instead
of deploying from your machine, you'd need to add both vars — including the
`NEXT_PUBLIC_` ones — under that project's "Build variables and secrets"
settings, since a fresh CI checkout won't have `.env.local`.)

### 3a. Staging database isolation

`v0.2` is production. Staging must never build against the v0.2 Supabase project.
The staging GitHub Actions workflow therefore reads different secrets and fails
closed if they are missing or equal to production:

```bash
gh secret set STAGING_NEXT_PUBLIC_SUPABASE_URL
gh secret set STAGING_NEXT_PUBLIC_SUPABASE_ANON_KEY
gh secret set STAGING_SUPABASE_SERVICE_ROLE_KEY
```

`STAGING_SUPABASE_SERVICE_ROLE_KEY` is server-only: the staging deploy workflow
pipes it into the Cloudflare Worker as runtime `SUPABASE_SERVICE_ROLE_KEY` after
deploy. The staging Worker runtime secret must be the staging project's
service-role key, not the production key:

```bash
cd dashboard
# reads .env.staging.local, refuses to use .env.local for staging
./scripts/set-worker-secrets.sh staging
```

Minimum `.env.staging.local` Supabase entries:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<staging-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<staging anon key>
SUPABASE_SERVICE_ROLE_KEY=<staging service role key>
```

After setting these, push/dispatch `deploy-staging.yml` and smoke
`https://facundo-staging.example.org/api/jobs`: unauthenticated should return
`401`, and an authenticated session should show only staging data.

### 3b. PostHog (session replay) — one manual toggle, easy to miss

Session replay records both the staff console and the florist PWA. Two things
must both be true, and the failure mode when the second is missing is silent:

1. **`NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` present at build time.** Locally that means
   `dashboard/.env.local`; in CI it's the `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` GitHub
   Actions secret, already wired into both `deploy-staging.yml` and
   `deploy-v2.yml` (`gh secret set NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`). Build without it
   and PostHog no-ops — deliberately, so local dev stays quiet — and the only
   fix is a rebuild.
2. **"Record user sessions" enabled** in PostHog → Project settings → Session
   replay. **Without this you get no recordings and no error**: init succeeds,
   pageviews and events flow normally, and replay is simply never armed. If
   analytics look fine but the replay list is empty, check this first.

   After flipping it, **give it 5 minutes**. The client reads this from
   `https://eu-assets.i.posthog.com/array/<token>/config.js`, served
   `cache-control: public, max-age=300` — so a browser that loaded the page
   while replay was still off keeps a cached `sessionRecording: false` for up to
   5 minutes and won't record, even though the setting is now on. It self-heals;
   a cache-bypassing reload (⇧⌘R) forces it immediately. Confirm it's armed by
   looking for a request to `.../static/recorder.js` and POSTs to
   `https://eu.i.posthog.com/s/` in the network tab — those two mean replay is
   genuinely streaming.

That toggle is also the **off switch**: it stops recording immediately with no
redeploy, which the build-time key cannot do.

`NEXT_PUBLIC_POSTHOG_HOST` is set to `https://eu.i.posthog.com` in both
workflows — EU region, since these are EU customers. It defaults to the same
value in code if unset.

### 3c. What is deliberately NOT recorded

Two exclusion rules live in `lib/analytics.ts`. Both are intentional — if replay
looks "missing" somewhere, check here before assuming a bug:

1. **Replay is off on localhost and staging** (any host that is `localhost` /
   `127.0.0.1` / `*.local`, or whose hostname contains `staging`). Events and
   pageviews still flow from those hosts, so a deploy stays verifiable — it's
   only the recording that's suppressed. Production (`facundo.example.org`)
   records normally.
2. **`NEXT_PUBLIC_POSTHOG_EXCLUDED_EMAILS`** — a comma-separated list of internal
   emails opted out of PostHog *entirely* (no replay, **and** no events), so the
   team's own clicks don't skew funnels or fill the replay list. Set in both
   workflows; unset = exclude nobody. Build-time like the token, so changing the
   list needs a rebuild.

   The opt-out persists in browser storage, so once an excluded user has loaded
   the app, that browser stops sending anything from init onward. Removing
   someone from the list re-enables them automatically on their next sign-in (the
   code opts them back in) — no need to clear storage by hand.

**Two consequences worth knowing, both deliberate:**

- **Pre-auth pages are never recorded.** Replay starts only once a signed-in user
  is resolved (`identifyUser`), not at init — that's what keeps an excluded user
  from ever being *recorded*. The trade-off: the staff sign-in screen and
  `/florist/login` produce no replays. If you need to watch someone fail to log
  in, revisit `disable_session_recording` in `instrumentation-client.ts`.
- **An excluded user's very first pageview on a fresh browser still lands.**
  Identity isn't known until hydration, but posthog captures its initial
  `$pageview` on a 1ms timer at init, so it wins that race. Once `identifyUser`
  runs, the opt-out is written to storage and *nothing* is sent from then on —
  including on every later page load. So the exposure is at most one `$pageview`
  per browser, never replay. (`resetUser()` deliberately re-applies the opt-out
  after `posthog.reset()`, which would otherwise delete the marker and make this
  recur on every sign-out.) Closing that last gap entirely would mean opting
  everyone out by default and losing the first pageview of every session for
  every real user — not worth it.

**Privacy, so it's a decision and not a surprise:** masking is at PostHog's
default — input values are masked (passwords always), but *rendered text is
not*. Recordings therefore contain readable customer names, addresses and card
messages on `/orders` and `/cx`, and payout figures on the florist pages. To
tighten this, add `session_recording: { maskTextSelector: "*" }` in
`instrumentation-client.ts` (global), or mark individual elements
`.ph-no-capture`. Neither needs a refactor.

## 4. Build and deploy

```bash
npm run cf:deploy
```

This runs, in order: `opennextjs-cloudflare build` (produces the Worker
bundle in `.open-next.nosync/`, then symlinks `.open-next` to it — see the
iCloud note below) and `opennextjs-cloudflare deploy` (runs `wrangler
deploy` using `wrangler.jsonc`).

Wrangler will print the deployed `*.workers.dev` URL, e.g.
`https://facundo-dashboard-staging.<your-subdomain>.workers.dev`.

To preview locally against a real Worker runtime first (optional, doesn't
deploy):

```bash
npm run cf:preview
```

## 4b. Deployed URLs

One Worker (`facundo-dashboard-v2`) serves every hostname below. Which
*surface* each one serves is decided by `middleware.ts` (logic in
`lib/hostRouting.ts`), not by the route — a Worker route only controls whether
the request reaches the Worker at all.

| Hostname | Serves | How it's routed | Status |
| --- | --- | --- | --- |
| `florist.fc.example.net` | Florist PWA only (`/` → `/florist`; staff paths 404) | Cloudflare for SaaS custom hostname + `zone_name` route | live |
| `bo.fc.example.net` | Staff backoffice only (`/florist/**` 404s) | same | live |
| `facundo.example.org` | Both surfaces, unrestricted | `custom_domain: true` | live |
| `facundo-v0-2.example.org` | Both surfaces, unrestricted | `custom_domain: true` | live |
| `facundo-staging.example.org` | Both surfaces, unrestricted | staging Worker (separate) | live |

The `example.org` hosts are deliberately left unrestricted so the existing staff
workflow keeps working during the cutover — `lib/hostRouting.ts` passes through
any hostname it doesn't recognise, including `localhost` for dev.

### Adding a `*.fc.example.net` hostname

`fc.example.net` is **not** a zone on this Cloudflare account (its DNS is at
GoDaddy), so these do NOT use `custom_domain: true` — that would try to create a
DNS record in a zone we don't control. Four steps, in this order:

1. **Cloudflare** → `example.org` zone → SSL/TLS → Custom Hostnames → Add, with
   DCV method **TXT** (not HTTP — the hostname doesn't point at Cloudflare yet).
   Requires the fallback origin `service.example.org` (`AAAA 100::`, proxied).
2. **GoDaddy** → add the two TXT records Cloudflare shows
   (`_acme-challenge.<label>`, `_cf-custom-hostname.<label>`). GoDaddy
   auto-appends the domain — enter the **label only**, not the FQDN.
3. Wait for the hostname to read **Active**, *then* add
   `CNAME <label> → service.example.org`. Adding the CNAME first means traffic
   arrives before the cert exists and every visitor gets a TLS error.
4. **`wrangler.jsonc`** → add `{ "pattern": "<host>/*", "zone_name": "example.org" }`.
   `zone_name` is required: the pattern's hostname is in no zone on this account,
   so wrangler can't infer the owner.

Gotcha worth knowing: a route whose hostname has no custom hostname behind it
**does not fail the deploy**. Wrangler registers it happily and the only symptom
is a **522** at request time. Route changes also take ~1 minute to propagate, so
re-test before debugging a fresh 522.

## 5. Point OAuth at the new URL

Every hostname staff or florists sign in on needs its own callback entry — the
redirect is built from `window.location.origin` (`lib/auth.ts`), so
`bo.fc.example.net` and `florist.fc.example.net` each need adding or sign-in
fails after the Google bounce. Different hostnames are also different cookie
jars, so a session on one does not carry to another.

The Google sign-in flow needs the deployed URL registered in two places, or
sign-in will fail after the Google redirect:

1. **Supabase** → your project → Authentication → URL Configuration →
   Redirect URLs → add
   `https://facundo-dashboard-staging.<your-subdomain>.workers.dev/auth/callback`.
2. **Google Cloud Console** → your OAuth 2.0 Client ID → Authorized redirect
   URIs → add the same URL.

(Keep your existing `localhost:3001` redirect entries in both places too —
adding the staging URL is additive, not a replacement.)

## 6. Ingest runs on the Mac mini via a job queue

The Python CLI in `../ingest` spawns `uv run python main.py ...`, which needs a
Python runtime and `uv` on the machine the request runs on — Cloudflare Workers
has neither. So instead of running ingest on the edge, the deployment
**enqueues** it and the Mac mini runs it:

1. `INGEST_MODE=queue` (in `wrangler.jsonc`) makes `POST /api/ingest` insert a
   `queued` row in the `ingest_jobs` table (via the service-role key) instead of
   spawning. `POST /api/keywords` returns `503` there — keyword derivation
   happens on the Mac mini too — and the dashboard UI no longer calls it in queue
   mode (Re-run / Add-city skip the keyword prefetch).
2. `ingest/poll_jobs.py`, running on the Mac mini, claims each `queued` row and
   runs the normal `main.py` pipeline against the **same** Supabase project. The
   dashboard's jobs panel shows progress live (a `queued` job appears with an
   amber clock until the poller picks it up).

**Setup the poller once on the Mac mini** — see `ingest/POLLER.md`. The short
version: `uv run python poll_jobs.py` to test, then install the launchd agent
(`ingest/com.facundo.ingest-poller.plist.example`) so it auto-starts on login
and restarts on crash. With the poller running, clicking **Re-run** or **Add
city** on `facundo.example.org` queues a job the Mac mini runs within
seconds.

You can still run ingest fully manually on the Mac mini at any time
(`cd ingest && uv run python main.py --country ES --city Sitges`) — the queue is
additive, not a replacement.

Apply the schema change for the queue once (Supabase SQL editor):
`supabase/migrations/2026-07-03-ingest-queue.sql`.

## Files involved

- `wrangler.jsonc` — Worker name, compatibility date/flags, assets binding,
  `INGEST_MODE=queue` var.
- `ingest/poll_jobs.py` + `ingest/POLLER.md` +
  `ingest/com.facundo.ingest-poller.plist.example` — the Mac-mini queue
  poller and its launchd setup.
- `open-next.config.ts` — minimal OpenNext config (no incremental cache
  override; every route here is `force-dynamic`, so there's nothing to
  cache, and this avoids provisioning a new R2 bucket).
- `.dev.vars.example` — template for local `wrangler dev`/`preview` secrets.
  Copy to `.dev.vars` (gitignored) if you want to exercise secrets locally
  without hitting `wrangler secret put`.

## iCloud gotcha (informational — already handled for you)

This repo lives under `~/Documents`, which is iCloud-synced and can evict
rapidly-written build directories mid-build. `dashboard/.next` is already
symlinked to `.next.nosync` to work around this. OpenNext's own build tool
(`@opennextjs/aws`'s `initOutputDir()`) unconditionally deletes and
recreates whatever sits at `.open-next` on every build, which would destroy
a pre-existing symlink there — so the `cf:build` script instead lets the
tool write a real `.open-next` directory, then immediately moves it into
`.open-next.nosync` and re-symlinks `.open-next` back to it. This protects
the artifact from iCloud eviction for as long as it sits on disk before
`wrangler dev`/`deploy` reads it. The brief window during the build itself
(while OpenNext writes into the real, synced `.open-next`) is not fully
eliminated — no config lever in `@opennextjs/cloudflare` 1.20.1 allows
retargeting just that path without also breaking where it looks for the
Next.js `.next` build output. If builds start failing with iCloud-looking
`ENOENT`s, pause "Optimize Mac Storage" for iCloud Drive for the duration
of the build, or move this checkout outside `~/Documents`.
