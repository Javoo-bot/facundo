import { describe, it, expect } from "vitest";
import { perSearchCap, normalizeItems, USD_PER_PLACE, type ApifyPlaceItem } from "../src/apify";

// The bug this file exists to prevent, in one line:
//
//   `maxCrawledPlacesPerSearch` is PER SEARCH STRING. Spain has 8 keywords. A
//   run asked for "limit 40" scraped 285 places and cost $1.14 against a
//   $6/month allowance. The operator asked for 40 and was billed for 285.

const ES_KEYWORDS = 8; // floristería, floristeria, florista, floreria, flors, lorategia, loreria, florist

describe("perSearchCap", () => {
  it("splits a city budget across the keywords that will run", () => {
    expect(perSearchCap(24, 8)).toBe(3);
    expect(perSearchCap(100, 10)).toBe(10);
  });

  it("rounds UP so the budget is reachable, never silently short", () => {
    // 25/8 = 3.125. Rounding down to 3 caps the city at 24 and the operator
    // never gets the number they asked for.
    expect(perSearchCap(25, 8)).toBe(4);
    expect(perSearchCap(1, 8)).toBe(1);
  });

  it("never returns 0 — every keyword still runs", () => {
    // Flooring at 1 matters: a 0 here would switch searches off entirely and
    // turn a small budget into a single-keyword search with far worse recall.
    for (const budget of [1, 2, 3]) {
      expect(perSearchCap(budget, 20)).toBeGreaterThanOrEqual(1);
    }
  });

  it("survives nonsense input rather than producing a huge run", () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      expect(perSearchCap(bad, 8)).toBe(1);
    }
    // No keywords at all: fall back to the budget itself, not to a division.
    expect(perSearchCap(25, 0)).toBe(25);
    expect(perSearchCap(25, NaN)).toBe(25);
  });

  // THE REGRESSION TEST. It asserts the actor INPUT, so it costs nothing to
  // run — which is the whole point: this is the check that would have caught
  // the €1.14 before the money was spent, rather than after.
  it("keeps a Spanish city inside its budget and its price", () => {
    const budget = 25;
    const perSearch = perSearchCap(budget, ES_KEYWORDS);
    const worstCasePlaces = perSearch * ES_KEYWORDS;

    expect(perSearch).toBe(4);
    expect(worstCasePlaces).toBeLessThanOrEqual(32);
    expect(worstCasePlaces * USD_PER_PLACE).toBeLessThan(0.15);

    // What the old per-keyword meaning would have done with the same number.
    const oldWay = budget * ES_KEYWORDS;
    expect(oldWay).toBe(200);
    expect(oldWay * USD_PER_PLACE).toBeGreaterThan(0.75);
  });
});

describe("normalizeItems truncation", () => {
  const place = (id: string): ApifyPlaceItem => ({ placeId: id, title: `Shop ${id}` });

  it("returns exactly the city budget when the actor over-delivers", () => {
    // The per-search cap rounds up, so N keywords can collectively exceed the
    // budget. `limit` has to mean what it says.
    const items = Array.from({ length: 32 }, (_, i) => place(`p${i}`));
    expect(normalizeItems(items, 25)).toHaveLength(25);
  });

  it("returns everything when no budget is given", () => {
    const items = Array.from({ length: 32 }, (_, i) => place(`p${i}`));
    expect(normalizeItems(items)).toHaveLength(32);
  });

  it("counts UNIQUE places against the budget, not raw rows", () => {
    // Duplicates are the normal case — the same shop matches several keywords.
    // If they counted, a city could return 5 real shops for a budget of 10.
    const items = [place("a"), place("a"), place("b"), place("b"), place("c")];
    const out = normalizeItems(items, 3);
    expect(out.map((f) => f.place_id)).toEqual(["a", "b", "c"]);
  });

  it("does not count placeId-less rows against the budget", () => {
    const items = [{ title: "no id" } as ApifyPlaceItem, place("a"), place("b")];
    expect(normalizeItems(items, 2)).toHaveLength(2);
  });
});
