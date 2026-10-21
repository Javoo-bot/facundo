# Facundo Florist Discovery POC — Claude Code Brief

Build a two-day POC that ingests florists in a target city, enriches them, and displays them in an interactive dashboard where scoring parameters can be adjusted live. Everything below is scoped to a **single-city POC**. It is not the production system.

## Goal

Given a country + city, produce:

1. A stored dataset of **all** florists found in that city, enriched with website presence, ecommerce detection, email, phone, and distance from city center.
2. An interactive dashboard that ranks them with adjustable weights, shows them on a map with rating-based pin colors, and selects a top-K spread evenly across the area.

## Non-goals (do not build these)

- No role management, invites, user administration, or account provisioning UI — auth is present but hard-coded to an allow list
- No sign-in providers other than Google or email/password — do not add magic links or other OAuth providers. (Email/password self-registration is supported, gated on the same `allowed_emails` allow list Google sign-in uses — see the root `CLAUDE.md`.)
- No sending of real outreach emails (the POC only *generates drafts* — see step 6)
- No admin UI beyond the dashboard
- No tests beyond one or two sanity assertions on the scoring math
- No CI/CD, no deployment automation (README instructions are enough)
- No error dashboards, monitoring, or observability
- No caching layers beyond Supabase itself

## Tech stack

- **Ingest pipeline:** Python 3.11+, `uv` for env management
  - `apify-client`, `httpx`, `beautifulsoup4`, `anthropic`, `supabase`, `geopy`, `python-dotenv`, `click`
- **Dashboard:** Next.js 15 (App Router), React 19, TypeScript
  - `@supabase/supabase-js`, `@supabase/ssr` (for cookie-based auth), `leaflet`, `react-leaflet`, `tailwindcss`
- **Database:** Supabase (managed Postgres)
- **Scraping source:** Apify Google Maps Scraper actor (`compass/crawler-google-places`)
- **LLM:** Anthropic Claude for extraction + email drafting (use `claude-sonnet-4-6`)

## Repo layout

```
facundo-poc/
├── ingest/
│   ├── pyproject.toml
│   ├── .env.example
│   ├── main.py               # CLI entry: `python main.py --country US --city Boston`
│   ├── scrape.py             # Apify wrapper
│   ├── geocode.py            # City-center lookup
│   ├── enrich.py             # Website + ecommerce + email extraction
│   ├── db.py                 # Supabase client + upsert helpers
│   └── prompts.py            # Claude prompts (extraction + email drafting)
├── dashboard/
│   ├── package.json
│   ├── next.config.mjs
│   ├── tsconfig.json
│   ├── tailwind.config.ts
│   ├── .env.local.example
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx          # Main dashboard page (server component, auth-gated)
│   │   ├── globals.css
│   │   └── auth/
│   │       └── callback/
│   │           └── route.ts  # OAuth callback: exchange code, check allow list
│   ├── components/
│   │   ├── Map.tsx           # Leaflet, dynamic import (SSR-safe)
│   │   ├── SliderPanel.tsx   # All parameter controls
│   │   ├── FloristTable.tsx  # Sortable table
│   │   ├── ScoreBreakdown.tsx# Per-florist score components popup
│   │   ├── CitySelector.tsx  # Dropdown of ingested cities
│   │   ├── SignInScreen.tsx  # Google sign-in button, shown when not authed
│   │   └── UserMenu.tsx      # Email + sign-out, top-right of dashboard
│   └── lib/
│       ├── supabase.ts       # Browser + server clients (@supabase/ssr)
│       ├── auth.ts           # signInWithGoogle(), signOut(), isAllowed()
│       ├── scoring.ts        # Pure functions: score(), filter()
│       ├── spread.ts         # Greedy diversity selection
│       └── types.ts          # Florist, City, Weights
├── supabase/
│   └── schema.sql            # Table definitions + RLS
└── README.md                 # Setup + run instructions
```

## Data model

Two tables. Denormalized enrichment fields on the florist row — keep it flat for a POC.

```sql
-- supabase/schema.sql

create table cities (
  id             uuid primary key default gen_random_uuid(),
  country        text not null,
  city           text not null,
  center_lat     double precision not null,
  center_lng     double precision not null,
  ingested_at    timestamptz not null default now(),
  unique (country, city)
);

create table florists (
  id                    uuid primary key default gen_random_uuid(),
  city_id               uuid not null references cities(id) on delete cascade,
  place_id              text not null,                -- Google Maps place_id, dedup key
  name                  text not null,
  address               text,
  lat                   double precision,
  lng                   double precision,
  rating                double precision,             -- e.g. 4.6
  review_count          integer,
  distance_km_from_center double precision,           -- computed at ingest
  -- Maps-native fields
  phone_maps            text,
  website_url           text,
  -- Enrichment fields (nullable — flag when unknown, do not fake)
  has_website           boolean not null default false,
  is_ecommerce          boolean,                       -- null = unknown
  ecommerce_signals     jsonb,                         -- {"platform": "shopify", "cart_link": true, ...}
  email                 text,                          -- best-guess primary
  phone_web             text,                          -- from website, if found
  owner_name            text,                          -- often null
  enrichment_notes      text,                          -- free-form: what was tried, why failed
  drafted_email         text,                          -- generated outreach draft
  ingested_at           timestamptz not null default now(),
  unique (city_id, place_id)
);

-- Read access requires an authenticated user (Supabase issues a JWT after Google sign-in;
-- app-layer allow-list is enforced in the OAuth callback, so anyone who reaches here is authorized)
alter table cities   enable row level security;
alter table florists enable row level security;
create policy "authed read cities"   on cities   for select to authenticated using (true);
create policy "authed read florists" on florists for select to authenticated using (true);
```

## Ingest pipeline

CLI: `python main.py --country US --city Boston [--limit 100]`

Order of operations:

1. **Geocode city center.** Use Nominatim (OpenStreetMap, free, no key) via `geopy.geocoders.Nominatim`. Cache in `cities` table — skip if already present.
2. **Scrape Apify.** Query: `"florist in {city}, {country}"`. Store raw fields: `place_id`, `title`, `address`, `location.lat/lng`, `totalScore` (rating), `reviewsCount`, `phone`, `website`.
3. **Compute distance from center** using `geopy.distance.geodesic`.
4. **Enrich each florist** (parallel with `httpx.AsyncClient`, ~5 concurrent max to be polite):
   - If no website → mark `has_website=false`, skip rest of enrichment, note in `enrichment_notes`.
   - Fetch homepage + `/contact` + `/about` + `/impressum` (Germany) with 5s timeout, User-Agent set.
   - **Ecommerce detection (rule-based first):** search the HTML for platform signals (`shopify`, `woocommerce`, `magento`, `bigcommerce`, `prestashop`), cart links (`/cart`, `/checkout`, `add-to-cart`), and product schema (`schema.org/Product`). If any match → `is_ecommerce=true`, record which signals in `ecommerce_signals`. If ambiguous (some but not all typical signals), fall through to Claude classification with confidence output. Cache the model's response.
   - **Email + phone extraction:** run a regex pass on all fetched pages, then send the top 10 candidates + surrounding context to Claude with a prompt asking for the *primary* business email (skip `noreply@`, CDN emails, `wixsite.com`, etc.). Same for phone.
   - **Owner name:** try `/about`, `/team`, `/impressum` first. Send extracted text to Claude with prompt asking for owner/founder name or `null` if not clearly identifiable. Do not guess — `null` is the correct answer more often than not.
   - Write everything to `enrichment_notes`: what URLs were fetched, what signals matched, what fields ended up null. This transparency matters for the demo.
5. **Upsert to Supabase** using `(city_id, place_id)` as the conflict key. Re-running the CLI on the same city updates rather than duplicates.
6. **Draft outreach email** (per florist that has an email address). Use Claude with a prompt that includes the florist's name, city, rating, review count, and whether they have ecommerce. Follow this rough template (adjust to the client's example if they provided one):
   > Subject: Partnering with Facundo — {city} florists
   > Hi {owner_name or "there"},
   > I came across {name} while looking for high-quality florists in {city} — your {rating}★ rating over {review_count} reviews stood out. Facundo is [1-line value prop]. We're building a partner network across Europe and I'd love to send you the details.
   > [CTA link placeholder]
   > Best, [signature]
   Store as `drafted_email`. Do not send anything.

Ingest is idempotent. Running twice = same result.

## Scoring algorithm (client-side, pure functions in `lib/scoring.ts`)

```ts
export type Weights = {
  rating: number;         // default 1.0
  reviews: number;        // default 0.8
  website: number;        // default 0.5
  ecommerce: number;      // default 1.0
  distance: number;       // default 0.3 (penalty)
  minRating: number;      // default 4.0
  minReviews: number;     // default 20
};

export function score(f: Florist, w: Weights): number {
  return (
      w.rating    * (f.rating - 3.0)
    + w.reviews   * Math.log10((f.review_count ?? 0) + 1)
    + w.website   * (f.has_website ? 1 : 0)
    + w.ecommerce * (f.is_ecommerce === true ? 1 : 0)
    - w.distance  * (f.distance_km_from_center ?? 0)
  );
}

export function passesFilter(f: Florist, w: Weights): boolean {
  return (f.rating ?? 0) >= w.minRating
      && (f.review_count ?? 0) >= w.minReviews;
}

// For the ScoreBreakdown popup — return each term separately so we can display
// why each florist scored what they scored.
export function scoreBreakdown(f: Florist, w: Weights) {
  return {
    rating:    w.rating    * (f.rating - 3.0),
    reviews:   w.reviews   * Math.log10((f.review_count ?? 0) + 1),
    website:   w.website   * (f.has_website ? 1 : 0),
    ecommerce: w.ecommerce * (f.is_ecommerce === true ? 1 : 0),
    distance: -w.distance  * (f.distance_km_from_center ?? 0),
  };
}
```

Design note: `log10` on reviews prevents review-count from dominating (a florist with 500 reviews isn't worth 10× one with 50). Distance is subtracted, so higher-distance = lower score.

## Spread algorithm (client-side, `lib/spread.ts`)

Greedy diversity — take the highest-scoring florist that isn't too close to any already-selected florist.

```ts
export function selectSpread(
  ranked: Florist[],          // pre-sorted by score, descending
  k: number,                  // default 5
  minSeparationMeters: number // default 500
): Florist[] {
  const selected: Florist[] = [];
  for (const f of ranked) {
    if (selected.length >= k) break;
    const tooClose = selected.some(s => haversineMeters(f, s) < minSeparationMeters);
    if (!tooClose) selected.push(f);
  }
  return selected;
}

function haversineMeters(a: Florist, b: Florist): number {
  const R = 6371000;
  const toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat/2)**2
          + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
```

## Dashboard

Single-page Next.js app. Layout: sidebar left (sliders + city selector), main pane on the right (map top ~60%, table bottom ~40%). Tailwind for styling.

### Authentication

Simple Google-only sign-in with a hard-coded email allow list. No sign-up, no invites, no role management.

**Setup (one-time, in Supabase Dashboard):**
- Enable Google provider under Authentication → Providers.
- The developer creates a Google Cloud OAuth 2.0 Client (Web application), sets the authorized redirect URI to `https://<project>.supabase.co/auth/v1/callback`, and pastes Client ID + Secret into Supabase. This is a manual step documented in the README; do not attempt to automate it.

**Allow list:**
- `ALLOWED_EMAILS` env var (server-side only, **not** `NEXT_PUBLIC_`) holds a comma-separated list of authorized emails. Example: `marketing@fc.example.com,staff@example.com`.
- Enforcement lives in the OAuth callback route. Client bundles never see the list.

**Flow:**
1. Unauthenticated visitor lands on `/` → server component sees no session → renders `<SignInScreen />` with a single "Sign in with Google" button.
2. Button calls `supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: '${origin}/auth/callback' } })`.
3. Google → Supabase callback → redirects to our `/auth/callback?code=…`.
4. `app/auth/callback/route.ts` (server): exchanges the code via `supabase.auth.exchangeCodeForSession(code)`, reads the user's email, checks against `ALLOWED_EMAILS`. If not on the list → `supabase.auth.signOut()` and redirect to `/?error=unauthorized`. If authorized → redirect to `/`.
5. Back on `/`, server component sees a valid session → renders the dashboard.

**`SignInScreen.tsx`:** centered card, single Google button, and if `?error=unauthorized` is present in the URL, a short line: *"This email isn't authorized for the demo. Contact your administrator."*

**`UserMenu.tsx`:** top-right of the dashboard, shows signed-in email and a "Sign out" button (`supabase.auth.signOut()` + hard refresh).

**`lib/supabase.ts`:** exports a `createBrowserClient()` and `createServerClient()` following the standard `@supabase/ssr` pattern for App Router.

**Sanity guard:** the dashboard's data fetching still uses the anon key + user JWT (via `@supabase/ssr` cookies), so RLS gets a real `authenticated` role. Signed-out users, or authorized-but-expired sessions, get zero rows even if they hit the URL directly.

### Data flow

1. Server component (`app/page.tsx`) reads session via `@supabase/ssr` server client. No session → render `<SignInScreen />` and return. Session but not in `ALLOWED_EMAILS` should be impossible at this point (callback would have signed them out), but check defensively and sign out if so.
2. Session valid: fetch all rows from `florists` joined with `cities` via the server client. RLS on `authenticated` role admits the read. A few hundred rows client-side is fine, no pagination.
3. Pass initial data to a client component (`<DashboardClient />`) that holds florists + weights in `useState`.
4. When any slider moves: recompute `filtered → scored → sorted → spreadSelected` synchronously via `useMemo`. Map and table re-render.
5. No server round-trip for scoring — everything is client-side math.

### `Map.tsx`

- **Dynamic import** to avoid SSR issues: `dynamic(() => import('./Map'), { ssr: false })`.
- Leaflet with OpenStreetMap tiles (free, no key).
- Center on `city.center_lat/lng`, initial zoom 12.
- One layer: **all filtered florists** — pin color by rating band:
  - Green `≥4.5`, lime `4.3–4.5`, amber `4.0–4.3`, red `<4.0`
  - Use `L.divIcon` with a small circular SVG so colors are crisp
- Second layer: **spread-selected top-K** — same location but larger pin with a distinct outline (e.g., dark ring), rendered on top.
- **City center marker:** star icon, distinct color.
- Popup on pin click: name, rating, reviews, website link (if any), email (if any), phone, distance from center, and a "Show breakdown" button that opens `ScoreBreakdown` in a modal or side panel.
- Hovering a table row → highlight the corresponding pin (open its popup). Bidirectional sync.

### `SliderPanel.tsx`

Sections:
- **Filters:** minRating (3.0–5.0, step 0.1), minReviews (0–500, step 5)
- **Weights:** rating, reviews, website, ecommerce, distance (each 0–2, step 0.1)
- **Selection:** topK (1–20), minSeparationMeters (0–2000, step 100)
- Include a "Reset to defaults" button.

Each slider shows its current value next to the label. Sliders update state on every change; UI reacts instantly.

### `FloristTable.tsx`

Columns: rank, name, rating, reviews, has_website (✓/✗), is_ecommerce (✓/✗/?), distance (km, 2dp), email (or `—`), phone (or `—`), score (2dp).
- Rows sorted by score descending, showing filtered-only.
- Top-K spread-selected rows highlighted (background tint).
- Click on a row → open the same `ScoreBreakdown` view as the map popup.
- Hover row ↔ map pin sync.

### `ScoreBreakdown.tsx`

A small panel showing each score component and its numeric contribution, so it's obvious *why* a florist ranked where they did. Bar-chart-lite: horizontal bars per component, positive/negative colors.

### `CitySelector.tsx`

Dropdown listing all ingested cities from the `cities` table. Changing selection re-fetches florists filtered to that city.

## Environment variables

`ingest/.env.example`:
```
APIFY_TOKEN=
ANTHROPIC_API_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=   # ingest uses service role for writes
```

`dashboard/.env.local.example`:
```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=   # dashboard uses anon key + user JWT via cookies; RLS enforces authenticated
ALLOWED_EMAILS=                  # comma-separated; server-side only, never NEXT_PUBLIC_
```

## Running

```bash
# 1. Set up Supabase project, run schema.sql in the SQL editor
# 2. Configure Google OAuth (one-time, manual, in the Supabase Dashboard):
#    a. Google Cloud → APIs & Services → Credentials → Create OAuth 2.0 Client (Web application)
#    b. Set authorized redirect URI: https://<project>.supabase.co/auth/v1/callback
#    c. In Supabase Dashboard → Authentication → Providers → Google: paste Client ID + Secret, enable
# 3. Copy env files and fill in keys (including ALLOWED_EMAILS in dashboard/.env.local)

# Ingest one city (~5–10 minutes for ~100 florists)
cd ingest
uv sync
uv run python main.py --country US --city Boston

# Dashboard
cd ../dashboard
npm install
npm run dev
# → open http://localhost:3000
# → sign in with a Google account whose email is in ALLOWED_EMAILS
```

## Definition of done

- I can run `python main.py --country US --city Boston` and get ~50–150 florists in Supabase with enrichment fields populated (nullable where genuinely unknown).
- Visiting the dashboard while signed out shows only the sign-in screen — no florist data leaks in the network tab.
- Signing in with a Google account **not** in `ALLOWED_EMAILS` bounces back to the sign-in screen with the "not authorized" message; no session persists.
- Signing in with an allow-listed Google account lands on the dashboard with the map centered on the selected city and pins colored by rating band.
- Moving any slider re-ranks the table and updates the spread-selected pins on the map within a frame.
- Clicking any florist shows a score breakdown explaining each component's contribution.
- Signing out returns to the sign-in screen and clears the session.
- Re-running the ingest CLI is idempotent — same florist count, updated enrichment where it changed.
- README explains setup in ~15 lines (auth-provider config is a manual step, referenced not scripted).

## Assumptions and known limitations (mention in the demo)

- Owner-name match rate is inherently low (~40%). Nulls are expected.
- Email match rate is ~60–70% on florists with a website. Below that, we fall back to Maps phone.
- Ecommerce detection is high-confidence when platform signals are found (~90% of florists that have ecommerce); the LLM fallback handles the ambiguous middle.
- Google Maps scraping via Apify is against Google's ToS. This is a client-approved risk for the POC.
- No GDPR sign-off yet, hence no real email sending. Drafts are stored only.

## Out-of-scope deliverables (built separately, not by this brief)

- Two 1-page writeups will accompany the POC: "Scaling to 1000 cities + multi-language" and "Onboarding flow (SLA + price agreement)". These are prose deliverables written by hand, not built here.
