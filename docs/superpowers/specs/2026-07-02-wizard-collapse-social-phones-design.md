# Add-city wizard, collapsible groups, social email, phone normalization

Date: 2026-07-02. Four refinements. Frontend: #1 wizard, #2 collapsible groups.
Backend: #3 social-link email scraping, #4 phone normalization.

## #1 — Add-city as a 3-step wizard (dashboard, AddCityDialog)
Restructure the dialog into a stepper (progress indicator "1 Location · 2 Scope ·
3 Keywords"):
- Step 1 **Location**: Country + City. Next enabled when both non-empty. Kick off the
  `/api/keywords` fetch in the background when leaving step 1 (or on country blur) so
  step 3 is ready.
- Step 2 **Scope**: Radius (km, default 10) + Limit (per keyword, default 40). Back/Next.
- Step 3 **Keywords**: editable keyword chips (auto-loaded from cache/Claude via
  `/api/keywords`; user can add/remove; language badge). Loading + error states. Back +
  **Ingest**.
- On Ingest: live streaming progress (reuse `useIngestStream`), then success sub-state
  ("Boston, US added." + Done → close + `router.refresh()`).
- A11y: focus first field of each step on entry; Escape/backdrop disabled while
  ingesting; keep the existing modal shell + focus trap. Reuse all existing ingest
  logic — only the layout becomes stepped.

## #2 — Collapsible country/region groups (dashboard, CitiesTable)
- Country rows and region rows get a ▸/▾ toggle (button in the City cell,
  `aria-expanded`). Collapsing a country hides its regions + cities; collapsing a
  region hides its cities. Default: all expanded.
- Track collapsed keys in component state (Set of `country` / `country|region`).
- Apply to the desktop table; the mobile card view may collapse per-country too if
  cheap, else leave expanded. Keep sort working within expanded groups.

## #3 — Email from social links (ingest, enrich.py)
When a florist's `website_url` (or a discovered link) is a social / link-in-bio URL
(instagram.com, facebook.com/fb.me, tiktok.com, linktr.ee, linktree, beacons.ai,
etc.):
- **Headless-render** the social page (they're JS) and run the existing extractors
  (email regex + mailto + JSON-LD + de-obfuscation) over the rendered bio / meta /
  `og:description` / page text.
- **Follow the outbound "link in bio"** — the external link the social/linktree page
  points to (a real site) — and run the normal crawl+extract there (the email often
  lives on the linked site, not the social page itself). Respect the existing page cap.
- Best-effort + honest: when Instagram (or any page) is login-walled/blocked, record
  that in `enrichment_notes` and leave fields null — never fabricate. Example target:
  Girona "les flors d'exemple" (email on their Instagram).
- Integrate into the existing crawl/render flow; add social-URL detection + bio-link
  prioritization. Keep concurrency limits.

## #4 — Phone normalization to E.164 (ingest)
- Add `phonenumbers` (Google libphonenumber port) + a country-name→ISO-3166-alpha-2
  resolution (via `pycountry`, or a small helper) to `ingest/pyproject.toml`.
- Normalize `phone_maps` and `phone_web` to E.164 (e.g. `+34 612 34 56 78`) using the
  city's **country as the default region** (Maps phones are often already `+CC`;
  local ones like `972 218 316` get the CC added). Keep the original string if
  unparseable (honest, no data loss). Apply where the florist row is finalized
  (`main.py` / `_build_row`), resolving the country's ISO code once per run.
- Display is unaffected (the table/city view just show cleaner numbers).

## Build split (parallel, separate dirs)
- **frontend-engineer** → `dashboard/`: #1 wizard, #2 collapsible groups.
- **backend-engineer** → `ingest/`: #3 social email scraping (enrich.py), #4 phone
  normalization (phonenumbers/pycountry, main.py).

## Non-goals
No login/authenticated social scraping (public best-effort only). No phone validation
UI. Keep POC-simple.
