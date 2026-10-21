"""The per-city place cap, and its parity with the TypeScript worker.
Run: uv run python test_scrape_cap.py

The bug this file exists to prevent, in one line:

    `maxCrawledPlacesPerSearch` is PER SEARCH STRING. Spain has 8 keywords. A
    run asked for "limit 40" scraped 285 places and cost $1.14 against a
    $6/month allowance. The operator asked for 40 and was billed for 285.

Mirrors ingest-worker/test/apifyCap.test.ts case for case — the two
implementations must not drift, in the spirit of lib/workingSet.test.mjs.
"""
from scrape import per_search_cap, USD_PER_PLACE

# floristería, floristeria, florista, floreria, flors, lorategia, loreria, florist
ES_KEYWORDS = 8

failures: list[str] = []


def check(label: str, actual, expected) -> None:
    if actual != expected:
        failures.append(f"{label}: expected {expected!r}, got {actual!r}")


# ---- splitting the budget ----
check("24 over 8", per_search_cap(24, 8), 3)
check("100 over 10", per_search_cap(100, 10), 10)

# Rounds UP so the budget is reachable. Rounding 25/8 down to 3 would cap the
# city at 24 and the operator would never get the number they asked for.
check("25 over 8 rounds up", per_search_cap(25, 8), 4)
check("1 over 8", per_search_cap(1, 8), 1)

# Never 0. A 0 would switch searches off entirely and turn a small budget into
# a single-keyword search with far worse recall.
for budget in (1, 2, 3):
    if per_search_cap(budget, 20) < 1:
        failures.append(f"budget {budget} over 20 keywords returned < 1")

# Nonsense input degrades to 1 rather than to a huge run.
check("zero budget", per_search_cap(0, 8), 1)
check("negative budget", per_search_cap(-5, 8), 1)
# No keywords at all: fall back to the budget itself, not to a division.
check("no keywords", per_search_cap(25, 0), 25)

# ---- THE REGRESSION TEST ----
# Asserts the actor INPUT, so it costs nothing to run. That is the point: this
# is the check that would have caught the €1.14 before the money was spent.
budget = 25
per_search = per_search_cap(budget, ES_KEYWORDS)
worst_case_places = per_search * ES_KEYWORDS

check("ES per-search at budget 25", per_search, 4)
if worst_case_places > 32:
    failures.append(f"ES worst case {worst_case_places} places exceeds 32")
if worst_case_places * USD_PER_PLACE >= 0.15:
    failures.append(f"ES worst case costs ${worst_case_places * USD_PER_PLACE:.2f}, expected < $0.15")

# What the OLD per-keyword meaning did with the same number.
old_way = budget * ES_KEYWORDS
check("old per-keyword meaning", old_way, 200)
if old_way * USD_PER_PLACE <= 0.75:
    failures.append("the old meaning should have been demonstrably more expensive")

# ---- parity with ingest-worker/src/apify.ts::perSearchCap ----
# Same inputs, same outputs. Hard-coded rather than imported so this test fails
# if EITHER side moves, which is the only way it can catch drift.
PARITY = {(24, 8): 3, (25, 8): 4, (100, 10): 10, (1, 8): 1, (0, 8): 1, (25, 0): 25, (-5, 8): 1}
for (places, kw), expected in PARITY.items():
    check(f"parity per_search_cap({places}, {kw})", per_search_cap(places, kw), expected)

if failures:
    print(f"FAILED ({len(failures)}):")
    for f in failures:
        print("  -", f)
    raise SystemExit(1)
print(f"ok - per_search_cap: budget 25 over {ES_KEYWORDS} ES keywords "
      f"= {per_search}/search, <= {worst_case_places} places, "
      f"<= ${worst_case_places * USD_PER_PLACE:.2f} (was ${old_way * USD_PER_PLACE:.2f})")
