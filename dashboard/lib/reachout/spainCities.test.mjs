import test from "node:test";
import assert from "node:assert/strict";
import {
  SPAIN_CITIES,
  spainCityLines,
  spainCityBatches,
  citiesToScrape,
  planIngestRequests,
  PLACES_PER_CITY,
  scrapeTargets,
  estimateSpendUsd,
  baseRadiusKm,
  BIG_CITY_POPULATION,
  USD_PER_PLACE,
} from "./spainCities.ts";
import { parseCityList } from "../cityList.ts";
import { haversineKm } from "../geo.ts";
import { parseBatchCities } from "../ingestBatch.ts";

test("the list is 50 cities with no duplicates", () => {
  assert.equal(SPAIN_CITIES.length, 50);
  const names = SPAIN_CITIES.map((c) => c.city.toLowerCase());
  assert.equal(new Set(names).size, names.length, "a city is listed twice");
});

test("largest first, which is what makes a truncated run still worth having", () => {
  for (let i = 1; i < SPAIN_CITIES.length; i++) {
    assert.ok(
      SPAIN_CITIES[i - 1].population >= SPAIN_CITIES[i].population,
      `${SPAIN_CITIES[i].city} (${SPAIN_CITIES[i].population}) is listed after a smaller city`
    );
  }
});

// The list is worthless if the paste box rejects it, and the box is the ONLY
// way these reach the ingest queue.
test("every line parses through the real paste-box parser", () => {
  const raw = spainCityLines({ includeScraped: true }).join("\n");
  const { cities, errors } = parseCityList(raw);
  assert.deepEqual(errors, [], "the parser rejected a line");
  assert.equal(cities.length, scrapeTargets().length);
  assert.equal(cities[0].country, "ES");
});

test("accents and multi-word names survive the round trip", () => {
  // "A Coruña", "Alcalá de Henares", "Castellón de la Plana" — the names most
  // likely to be mangled, and the ones the geocoder needs verbatim.
  const { cities } = parseCityList(spainCityLines({ includeScraped: true }).join("\n"));
  const byName = new Set(cities.map((c) => c.city));
  for (const n of ["A Coruña", "Alcalá de Henares", "Castellón de la Plana", "Málaga", "Gijón"]) {
    assert.ok(byName.has(n), `${n} did not survive parsing`);
  }
});

test("the default paste skips cities already scraped", () => {
  const dflt = spainCityLines();
  const all = spainCityLines({ includeScraped: true });
  assert.ok(dflt.length < all.length, "nothing was filtered");
  assert.ok(!dflt.some((l) => l.endsWith(", Madrid")), "Madrid is scraped and should be skipped");
  assert.ok(dflt.some((l) => l.endsWith(", Zaragoza")), "Zaragoza is not scraped and should be included");
});

test("lines are in the exact shape the box expects", () => {
  for (const line of spainCityLines({ includeScraped: true })) {
    assert.match(line, /^ES, .+$/, `bad line: ${line}`);
  }
});

// ---------------------------------------------------------------------------
// Radius. Both halves of the rule, and the invariant that overrides it.
// ---------------------------------------------------------------------------

test("a city has a radius or a coverer, never both and never neither", () => {
  for (const c of SPAIN_CITIES) {
    const hasRadius = typeof c.radiusKm === "number";
    const hasCoverer = typeof c.coveredBy === "string";
    assert.ok(hasRadius !== hasCoverer, `${c.city}: radiusKm and coveredBy must be exclusive`);
    if (hasRadius) assert.ok(c.radiusKm > 0, `${c.city}: non-positive radius`);
  }
});

test("the requested buckets: big cities 10 km, smaller ones 30 km", () => {
  assert.equal(baseRadiusKm(BIG_CITY_POPULATION), 10);
  assert.equal(baseRadiusKm(BIG_CITY_POPULATION - 1), 30);
  assert.equal(baseRadiusKm(3_423_000), 10);
});

// THE POINT: a shop inside two circles becomes two florist rows (florists is
// unique on (city_id, place_id), not place_id), which sets email_shared_count=2
// and makes autoEnrol block BOTH copies as "shared-address" — the shop is never
// mailed at all. Prod already holds 215 Spanish shops in this state from the
// Canaries runs (Santa Cruz/La Laguna, Las Palmas/Telde).
test("no two scrape targets' circles overlap", () => {
  const t = scrapeTargets();
  for (let i = 0; i < t.length; i++) {
    for (let j = i + 1; j < t.length; j++) {
      const a = t[i];
      const b = t[j];
      const d = haversineKm(a.lat, a.lng, b.lat, b.lng);
      assert.ok(
        a.radiusKm + b.radiusKm <= d + 0.5, // 0.5 km slack for rounded centres
        `${a.city} (${a.radiusKm}km) and ${b.city} (${b.radiusKm}km) are ${d.toFixed(1)}km apart — circles overlap`
      );
    }
  }
});

// The other direction: absorbing a city is only legitimate if the coverer's
// circle actually reaches it. Otherwise we have quietly dropped a market.
test("every absorbed city really is inside its coverer's circle", () => {
  const byName = new Map(SPAIN_CITIES.map((c) => [c.city, c]));
  for (const c of SPAIN_CITIES) {
    if (!c.coveredBy) continue;
    const parent = byName.get(c.coveredBy);
    assert.ok(parent, `${c.city}: coveredBy names a city not in the list`);
    assert.ok(parent.radiusKm, `${c.city}: coverer ${parent.city} has no radius of its own`);
    const d = haversineKm(c.lat, c.lng, parent.lat, parent.lng);
    assert.ok(
      d <= parent.radiusKm,
      `${c.city} is ${d.toFixed(1)}km from ${parent.city}, outside its ${parent.radiusKm}km circle`
    );
  }
});

test("all 50 cities are covered — none silently dropped", () => {
  const targets = scrapeTargets().length;
  const absorbed = SPAIN_CITIES.filter((c) => c.coveredBy).length;
  assert.equal(targets + absorbed, 50);
  assert.equal(absorbed, 9, "the Madrid, Barcelona and Sevilla belts");
  assert.equal(targets, 41);
});

// Soria, 2026-09-10: 10km -> 0 florists, 30km -> 24. A small town must not get
// the tight circle, or the run books a green `succeeded` row with nothing in it.
test("no small city is left on a circle tighter than a big city's", () => {
  for (const c of scrapeTargets()) {
    if (c.population >= BIG_CITY_POPULATION) continue;
    // Below the threshold a city gets 30 km unless the invariant forced it
    // down, in which case it must say so with a comment — the assertion here is
    // just that the exceptions stay a short, deliberate list.
    if (c.radiusKm !== 30) {
      assert.ok(
        ["Alcalá de Henares", "Cádiz"].includes(c.city),
        `${c.city} is under ${BIG_CITY_POPULATION} but on ${c.radiusKm}km with no documented reason`
      );
    }
  }
});

test("batches carry one radius each, because the ingest API takes one radius", () => {
  const batches = spainCityBatches({ includeScraped: true });
  const radii = batches.map((b) => b.radiusKm);
  assert.equal(new Set(radii).size, radii.length, "a radius appears in two batches");
  assert.equal(batches.reduce((n, b) => n + b.lines.length, 0), scrapeTargets().length);
  // MAX_CITIES in lib/ingestBatch.ts is 50 — every batch must fit in one call.
  for (const b of batches) assert.ok(b.lines.length <= 50, `batch ${b.radiusKm}km is too big`);
});

// THE POINT OF THE ESTIMATE: Apify's STARTER plan has a $19/month HARD cap that
// fails runs mid-flight rather than throttling. A 50-city run has to be checked
// against it before it starts, not after it dies at city 40.
test("a full capped run fits inside the $19 monthly ceiling", () => {
  const CEILING = 19;
  const capped = estimateSpendUsd(scrapeTargets().length, 25);
  assert.ok(capped < CEILING / 3, `every target at the cap costs $${capped.toFixed(2)}`);
  assert.equal(capped, 4.1);
});

test("an uncapped 50-city run does NOT fit, which is why the cap exists", () => {
  // ~115 places is what an uncapped Spanish city returned on 2026-09-09.
  assert.ok(estimateSpendUsd(50, 115) > 19, "uncapped should exceed the ceiling");
});

test("the estimate is the measured rate and never negative", () => {
  assert.equal(USD_PER_PLACE, 0.004);
  assert.equal(estimateSpendUsd(1, 285), 1.14, "matches the 285-place run that cost $1.14");
  assert.equal(estimateSpendUsd(-5, 25), 0);
  assert.equal(estimateSpendUsd(50, -1), 0);
});

// ---------------------------------------------------------------------------
// What the button actually POSTs. This is the money-spending path, so it is
// tested here rather than left to the component.
// ---------------------------------------------------------------------------

// An earlier version ordered batches widest-radius-first, believing the widest
// circles were the biggest markets. It is the reverse: a 30 km circle is what a
// SPARSE province needs, so that ordering put the smallest towns first.
test("the biggest market goes first, not the widest circle", () => {
  const batches = spainCityBatches({ includeScraped: true });
  assert.equal(batches[0].cities[0].city, "Madrid", "Madrid should lead");
  assert.notEqual(batches[0].radiusKm, 30, "the 30km group is the SMALLEST cities");
  const leads = batches.map((b) => b.cities[0].population);
  assert.deepEqual([...leads].sort((a, b) => b - a), leads, "batches not ordered by their largest city");
});

// The staging rehearsal runs ONE city so it costs ~$0.10 instead of ~$4.
test("max truncates in population order, so a 1-city test hits a real market", () => {
  const one = citiesToScrape({ max: 1 });
  assert.equal(one.length, 1);
  assert.equal(one[0].city, "Zaragoza", "largest unscraped city on the staging snapshot");
  assert.ok(one[0].population > 500_000, "a one-city test must exercise a real market");
  assert.equal(citiesToScrape({ max: 0 }).length, 0);
  assert.equal(citiesToScrape({ max: -3 }).length, 0, "a negative max must not mean everything");
});

test("a 1-city run is one request, and costs about ten cents", () => {
  const reqs = planIngestRequests({ max: 1 });
  assert.equal(reqs.length, 1, "one city cannot need two batches");
  assert.equal(reqs[0].cities.length, 1);
  assert.equal(reqs[0].cities[0].country, "ES");
  assert.equal(reqs[0].limit, PLACES_PER_CITY);
  assert.equal(estimateSpendUsd(1, PLACES_PER_CITY), 0.1);
});

test("every planned request is a body the real batch validator accepts", () => {
  for (const body of planIngestRequests({ includeScraped: true })) {
    const parsed = parseBatchCities(body);
    assert.ok(parsed.ok, `rejected: ${parsed.ok ? "" : parsed.message}`);
    assert.equal(parsed.value.cities.length, body.cities.length, "a city was dropped as a duplicate");
    assert.equal(parsed.value.radius, body.radius);
  }
});

test("the full run covers every target exactly once across its batches", () => {
  const planned = planIngestRequests({ includeScraped: true }).flatMap((b) => b.cities.map((c) => c.city));
  assert.equal(planned.length, scrapeTargets().length);
  assert.equal(new Set(planned).size, planned.length, "a city is in two batches");
});
