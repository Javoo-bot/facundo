# Facundo Florist Discovery POC — Design

Date: 2026-07-01

## Base spec

`facundo-poc-brief.md` (repo root) is the authoritative spec for the
data model, scoring/spread algorithms, component list, auth flow, env vars, and
definition of done. This document records the **build plan** and the
**deltas/corrections** decided during brainstorming. Where this document and the
brief disagree, this document wins.

## Build sequence

Credentials (Supabase, Apify, Anthropic, Google OAuth) are created by the user in
parallel with development, so we build in an order where nothing blocks on a key
that doesn't exist yet, and verify each phase as its credential lands.

### Phase 1 — Scaffold + schema (no credentials)
Repo skeleton per the brief's layout, `supabase/schema.sql` (two tables + RLS),
`.env.example` files, README, `CLAUDE.md`.
**Verify:** `schema.sql` runs clean in the Supabase SQL editor once the project exists.

### Phase 2 — Ingest pipeline (`ingest/`)
`main.py` CLI → geocode (Nominatim) → Apify scrape → distance → async enrich
(rule-based ecommerce/email/phone/owner, Claude fallback) → upsert → draft email.
**Verify:** `uv run python main.py --country US --city Boston` lands 50–150 enriched
florists in Supabase; re-running is idempotent (same count, updated enrichment).

### Phase 3 — Dashboard (`dashboard/`)
Next.js 15 App Router, Google-only auth with a hard-coded allow list enforced in the
OAuth callback, server-fetch florists, client-side `useMemo` scoring/spread, Leaflet
map with rating-band pins + spread overlay, slider panel, sortable table,
score-breakdown, city selector.
**Verify (chrome-devtools-mcp):** signed-out shows only the sign-in screen with no
florist data in the network tab; allow-listed Google sign-in reaches the dashboard;
non-allow-listed sign-in bounces with the unauthorized message and no persisted
session; sliders re-rank the table and spread pins within a frame; clicking a florist
shows per-component score contributions; sign-out clears the session.

## Deltas / corrections from the brief

- **Model:** `claude-sonnet-4-6` → **`claude-sonnet-5`** everywhere (`prompts.py`,
  README, `.env` comments). Current Sonnet-tier ID; same price tier.
- **Anthropic API surface:** enrichment/extraction calls use **structured outputs**
  (`output_config.format` with a JSON schema; Python SDK `messages.parse()`) for the
  ecommerce-confidence / email / phone / owner-name responses. **No `temperature` /
  `top_p`, no assistant prefills** — both are rejected on current models. Structured
  outputs are the clean fit for the brief's "return confidence" requirement.
- **Scoring null-safety (bug in the brief's code):** `score()` computes
  `w.rating * (f.rating - 3.0)` with no null guard. `rating`, `lat`, `lng`,
  `review_count`, and `distance_km_from_center` are all nullable in the schema. If
  `minRating` is dragged to 0, null-rating florists pass `passesFilter` and produce
  `NaN` scores. Guard rating/lat/lng/reviews/distance in `score()`, `scoreBreakdown()`,
  `spread.ts` (haversine), and the map pin/color logic.
- **Nominatim politeness:** custom `user_agent` + ≤1 request/sec per the OSM usage
  policy — handled in `geocode.py`.
- **Allow-list enforced in RLS (code-review finding, 2026-07-01):** the brief's
  `using (true)` read policies gate on *any* authenticated user, so the app-layer
  `ALLOWED_EMAILS` check could be bypassed by obtaining a Supabase session outside the
  app (the anon key is public). Fixed by an `allowed_emails` table + an
  `is_email_allowed()` `security definer` function that the RLS policies check the JWT
  email against. `ALLOWED_EMAILS` is retained as the app-layer UX gate (friendly
  bounce); the table is the security boundary. Migration:
  `supabase/migrations/2026-07-01-allowlist-rls.sql`.

## Testing

Per the brief's non-goal: one or two sanity assertions on the `scoring.ts` math only.
No broader suite.

## Out of scope (unchanged from brief)

No role management / non-Google auth / real email sending / admin UI beyond the
dashboard / CI/CD / monitoring / caching beyond Supabase. The two prose writeups
("Scaling to 1000 cities" and "Onboarding flow") are written by hand, not here.
