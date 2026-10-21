# Methodology

Plain-language companion to the in-dashboard "How scoring works" popover
(next to the Weights heading) and "How it works" modal (dashboard header).
Kept in sync by hand — this is a POC, not a generated doc.

## How scoring works

```
score = w.rating   · (rating − 3.0)
      + w.reviews  · log10(reviews + 1)
      + w.website  · (has_website ? 1 : 0)
      + w.ecommerce· (is_ecommerce ? 1 : 0)
      − w.distance · distance_km
```

- **3★ is the neutral baseline.** `rating − 3.0` means a 3-star florist
  contributes nothing from the rating term; below 3★ subtracts, above adds.
- **`log10(reviews + 1)` dampens review count.** A florist with 500 reviews
  isn't worth 10× a florist with 50 — the log keeps review volume from
  swamping every other signal.
- **Distance is subtracted.** Farther from the city center scores lower;
  `w.distance` controls how harsh that penalty is.
- **`has_website` / `is_ecommerce` are flat bonuses** — either present (1)
  or not (0), scaled by their weight. `is_ecommerce` uses `null` (unknown)
  as "not confirmed," same as `false`, for scoring purposes (the table still
  shows `?` for unknown so it isn't visually conflated with a confirmed no).
- **`minRating` / `minReviews` are hard filters, not weights.** A florist
  below either threshold is excluded from the ranked list entirely rather
  than scored down.

**Weights and computed scores are live, client-side state only.** They are
never persisted to the database or the URL. Reloading the dashboard resets
every slider to its default and recomputes scores from scratch.

## How data is collected

**Sources**

- Florist listings come from Google Maps, scraped via the Apify actor
  `compass/crawler-google-places`.
- The city center is geocoded once via OpenStreetMap Nominatim and cached on
  the `cities` row (`center_lat`/`center_lng`).
- Each ingest run scrapes florists within a **radius** (km) of that center —
  `cities.radius_km` — rather than a fixed city/administrative boundary, so
  florists just outside the nominal city limits are still picked up.
  Cities ingested before radius-based scraping shipped have `radius_km =
  null`; the dashboard shows "—" for those rather than fabricating a number.

**Enrichment**

For each florist that has a website, the ingest pipeline fetches the
homepage plus `/contact`, `/about`, `/team`, and `/impressum`. Ecommerce
detection, email extraction, and phone extraction all run a rule-based pass
first (platform signals like Shopify/WooCommerce/Magento, cart/checkout
links, `schema.org/Product` markup). When the rule-based signal is
ambiguous, a `claude-sonnet-5` fallback classifies the remaining cases.
Owner name is only ever filled in when a page explicitly states it (never
inferred), which is why it's null for most florists.

**Honest edge cases (worth saying out loud in a demo)**

- Sites that block bots (HTTP 403) or point at dead domains are left with
  null enrichment fields — the specific reason is recorded in that
  florist's `enrichment_notes` rather than guessed at.
- Google Maps scrape results can vary slightly between runs (Google's own
  ranking/pagination isn't perfectly stable).
- Owner name match rate is low by design (~40%) — `null` is the correct,
  honest answer more often than not.
- Re-running ingest on the same city is idempotent (upsert on
  `(city_id, place_id)`), so re-ingesting to pick up a wider radius or fresh
  enrichment won't duplicate rows.
