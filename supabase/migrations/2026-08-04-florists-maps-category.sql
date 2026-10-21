-- Persist Google's own Maps category on the florist row.
--
-- The relevance filter (ingest/relevance.py, ingest-worker/src/relevance.ts)
-- already reads `category_name` + `categories` off the scraped place — the free
-- rule (categoryMatchesFlorist) is what keeps most florists out of a paid Claude
-- call. But the scrape only ever held them in memory: `_build_bare_row`/`buildRow`
-- never wrote them, so the signal was discarded the moment ingest finished.
--
-- The cost of discarding it: an already-persisted florist can never be re-judged
-- without re-scraping. Non-florists that predate the filter (a lottery bar, a
-- funeral home, a garden-machinery distributor) sit in the directory and surface
-- in the order page's "Add florist" picker, and the only way to clean them is a
-- full re-ingest of the city. Storing the category makes a cheap re-judge possible
-- and gives the dashboard something to show for "why is this a florist?".
--
-- Nullable by design and NOT backfilled: rows scraped before this migration
-- genuinely have no stored category, and per the repo's honesty rule an unknown
-- field stays null rather than being guessed. They fill in on the next ingest of
-- their city (upsert on (city_id, place_id) writes the columns present).
alter table florists
  add column if not exists category_name text,
  add column if not exists categories    jsonb;

comment on column florists.category_name is
  'Google Maps'' primary category for this place (Apify `categoryName`, e.g. "Florist"). Captured by ingest/scrape.py::normalize_item. Null for rows scraped before 2026-08-04, and for places Google gives no category.';
comment on column florists.categories is
  'The full list of categories Google assigned (Apify `categories`, e.g. ["Florist","Gift shop"]). Together with category_name this is the input to the relevance filter''s free rule (relevance.py::category_matches_florist) — persisted so an existing florist can be re-judged without re-scraping.';
