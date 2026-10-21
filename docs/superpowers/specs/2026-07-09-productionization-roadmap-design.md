# Productionization roadmap — ingest on Cloudflare

**Date:** 2026-07-09
**Status:** Approved (roadmap level). Phase 0 has its own detailed spec:
`2026-07-09-phase0-drafting-and-multicity-design.md`.

## Why this exists

The POC's four follow-on asks —

1. make it robust,
2. accept a **list** of cities,
3. draft outreach email **on request**, not upfront,
4. run it **on Cloudflare** —

are not four independent features. Once the decision is to *productionize toward
real use* (continuous, high-volume, large/open-ended city coverage, Cloudflare
strongly preferred), all four collapse into a single target architecture. This
doc records that architecture, the one real risk in it, and the phased delivery
plan. **The POC non-goals in `CLAUDE.md` are lifted for this work.**

## Decisions taken (context for future sessions)

- **Ambition:** productionize toward real use (not "harden the POC in place").
- **Cadence / scale:** continuous / high-volume; hundreds+ of cities, ongoing.
- **Cloudflare strictness:** strongly preferred — worth a TS rewrite of ingest to
  consolidate on the platform the dashboard already runs on. (Not "no exceptions":
  the render step has a documented escape hatch, below.)
- **Start point:** Phase 0 first (ships value in days, de-risks the rewrite).

## Current state (as of this doc)

- **Dashboard already runs on Cloudflare** — OpenNext → Workers, auto-deploy on
  the `v0.2` branch, custom domain. See `dashboard/DEPLOY.md`.
- **Ingest does not.** The Python CLI (`ingest/`, ~2,700 lines, ~1,400 of it
  pipeline logic) runs on a Mac mini. The dashboard enqueues `ingest_jobs` rows
  (`INGEST_MODE=queue`) that `ingest/poll_jobs.py` claims and runs. The Mac-mini
  poller is the fragility this roadmap removes.
- Email drafting currently happens **inside** the batch pipeline
  (`ingest/main.py`, per florist with an email), which is what ask #3 changes.

## Target architecture

```
Dashboard (already on CF Workers)
   │  POST /api/ingest  { cities: [ {country, city}, ... ], radius, limit }   ← #2 list of cities
   ▼
Cloudflare Queue (ingest-jobs)  ── one message per city
   ▼
Ingest Worker (queue consumer)  ── spawns one Workflow per message
   ▼
Cloudflare Workflow  (one instance PER CITY)                                  ← #1 robustness
   step 1  geocode (Nominatim, HTTP)
   step 2  resolve keywords (Supabase cache; else Claude)
   step 3  scrape Apify (HTTP)
   step 4  enrich each florist  (fetch + cheerio; Browser Rendering binding
           only for thin JS-shell / social pages)
   step 5  upsert to Supabase (service-role, postgREST)
   └─ each step durably checkpointed: retry w/ backoff, survives restarts;
      one city failing never touches another.

Cron Trigger ──► enqueue scheduled re-enrich runs                             (Phase 2d)

Separate Worker route:  POST /api/florists/draft-email  { floristIds: [...] }  ← #3 on demand
   └─ pure Anthropic call in TS (one route serves per-florist + bulk).
      No Python, no batch pipeline.
```

**How each ask is satisfied:**

- **#1 Robust** — Cloudflare **Workflows** give durable, step-level execution
  (automatic retry w/ backoff, checkpointing, restart-survival) and full
  per-city isolation. **Queues** add retry + dead-letter. This is a strictly
  stronger story than "one big async run on a laptop." Delivered largely *for
  free* by the platform in Phase 2; operational visibility added in Phase 3.
- **#2 List of cities** — the queue *is* the batch mechanism: N cities → N
  messages → N independent Workflows. The `POST /api/ingest` contract accepts a
  list starting in Phase 0 (against the current poller), unchanged at cutover.
- **#3 On-demand drafting** — drafting is the one ingest step that is a pure LLM
  call, so it ports to a TS Worker route trivially and comes *out* of the batch
  pipeline. Shipped in Phase 0.
- **#4 Cloudflare** — the whole system is Workers + Queues + Workflows + Cron +
  Browser Rendering. Nothing self-hosted after Phase 2 cutover.

## The one real risk: Browser Rendering

The Playwright headless-render fallback in `ingest/enrich.py` (`render_page`,
`crawl_social_site`) is the only piece that does not map cleanly to Workers. On
Cloudflare it becomes the **Browser Rendering** binding, which has a different
cost/limit model than a long-lived local browser.

**Today (Mac mini):** one long-lived browser, cheap *contexts* inside it
(`MAX_CONCURRENT_RENDERS = 4`), render fired only as a fallback on thin/JS-shell
pages + social profiles. Launch cost paid once.

**On Cloudflare** the billed/limited unit is a whole **browser instance**, and two
limits bite (verified against Cloudflare docs, 2026-07-09, paid plan):

| Limit (paid) | Value | Impact |
|---|---|---|
| New instances / second | **1/sec, account-wide** | Throughput ceiling — city-Workflows serialize behind a global launch gate. |
| Concurrent instances | 120 | Fine; creation rate, not concurrency, is the bottleneck. |
| Idle timeout | 60s (→10 min via `keep_alive`) | A warm session bills while idle. |
| Billing | 10 browser-hrs/mo free, then **$0.09/browser-hr**; 10 concurrent free, then **$2/browser/mo** | Metered by wall-clock a browser is *open*, not pages rendered. |

**The tension:** dodge the 1/sec launch limit by keeping browsers *warm* → pay by
the hour (≈10 warm browsers 24/7 ≈ 7,200 browser-hrs/mo ≈ ~$650/mo). Launch
per-page instead → throttled to 1/sec globally, capping ingest throughput.
Everything else in the stack (Apify, Nominatim, Claude, Supabase, Workers/Queues/
Workflows) is cheap and horizontally scalable; **Browser Rendering is the single
CF-native piece with both a hard throughput gate and a per-hour meter.**

**Mitigations (design constraints for Phase 2c):**

1. **Measure render rate first** (Phase 1) — most florist sites are static; if
   only ~10–15% of florists need a render, the numbers are fine.
2. **Warm-pool via a Durable Object** — Cloudflare's recommended reuse pattern;
   size the pool to render *volume*, not city count.
3. **Cap + best-effort**, as today — an unrendered page yields an honest `null`
   (`is_thin_page`, "rendered but blocked" notes); the pipeline tolerates it.
4. **Question social rendering** — Instagram/Facebook are increasingly
   login-walled (the code already records "rendered but blocked"); the most
   expensive, least reliable render class. Consider dropping/deferring on CF.
5. **Escape hatch** — render is *one isolated Workflow step*; if CF cost/throughput
   is unacceptable, that step alone can call an external render service or a small
   Cloudflare Container while the rest stays Workers-native.

## Phased delivery

Each phase is its own spec → plan → implement cycle.

- **Phase 0 — Quick wins on the current stack** *(days; not throwaway)*
  - #3 On-demand drafting: remove drafting from the Python pipeline; add
    `POST /api/florists/draft-email` (TS + Anthropic). Per-florist **and**
    bulk "draft selected." Proves the LLM-in-TS pattern the rewrite depends on.
  - #2 Multi-city input: `POST /api/ingest` accepts `{ cities: [...] }`; dashboard
    paste-one-per-line UI. Runs against the existing poller. Forward-compatible
    contract. **Detailed spec:** `2026-07-09-phase0-drafting-and-multicity-design.md`.
- **Phase 1 — Measurement gate** *(hours)* — instrument the current pipeline to
  record actual render rate on 1–2 real cities. Go/no-go input for Phase 2c.
- **Phase 2 — TS-on-Cloudflare ingest rewrite** *(the big one; own multi-part spec)*
  - 2a Scaffold Worker + Queue + Workflow-per-city; port geocode + keywords +
    Apify scrape (HTTP). One city end-to-end, static-only enrichment.
  - 2b Port enrichment core: fetch + **cheerio**, link crawl/rank, email/phone
    extraction + deobfuscation, ecommerce signals, Claude structured outputs.
  - 2c Browser Rendering (warm-pool DO) for the thin/JS-shell fallback, sized
    from Phase 1.
  - 2d Cron Trigger for scheduled re-enrich; cut dashboard over to the new
    Worker; **decommission the Mac-mini poller.**
- **Phase 3 — Robustness & observability hardening** *(rest of #1)* — dead-letter
  queue + "failed cities" view; structured logging + Workers Tail/Analytics;
  alerting on failure rate; backoff/rate-limit tuning (Apify/Nominatim/Anthropic);
  idempotency verified at scale; cost-tracking parity (`llm_cost_by_type` +
  browser-hours).

## Explicit non-goals for this roadmap

- No change to auth (Google + email/password, allow-list in `allowed_emails`).
- No change to the Supabase schema beyond what each phase's spec calls out.
- No real outbound email behavior change — drafting only moves *when* it happens.
- Apify remains the scrape source; Nominatim remains geocoding.
