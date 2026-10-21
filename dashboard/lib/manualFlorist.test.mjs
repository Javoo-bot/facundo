import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCity, buildManualFloristRow, validateManualFlorist, isManualPlaceId } from "./manualFlorist.ts";

const BARCELONA = { id: "bcn", country: "ES", city: "Barcelona", center_lat: 41.3874, center_lng: 2.1686, radius_km: 10 };
const GIRONA = { id: "gio", country: "ES", city: "Girona", center_lat: 41.9794, center_lng: 2.8214, radius_km: 10 };

// --- which city does this shop belong to ---------------------------------

test("a shop inside a city's own ingest radius belongs to that city", () => {
  // ~2km from the Barcelona center.
  assert.equal(pickCity({ lat: 41.4036, lng: 2.1744 }, [BARCELONA, GIRONA])?.id, "bcn");
});

test("a shop outside every city's radius belongs to none, rather than the nearest", () => {
  // Perpignan — closer to Girona than to Barcelona, but well outside both radii.
  assert.equal(pickCity({ lat: 42.6887, lng: 2.8948 }, [BARCELONA, GIRONA]), null);
});

test("when radii overlap, the nearest center wins", () => {
  const wide = { ...GIRONA, id: "wide", center_lat: 41.39, center_lng: 2.17, radius_km: 50 };
  // Sitting almost on Barcelona's center, inside both.
  assert.equal(pickCity({ lat: 41.3875, lng: 2.1687 }, [wide, BARCELONA])?.id, "bcn");
});

test("a city predating radius-based scraping still covers its own shops", () => {
  const legacy = { ...BARCELONA, radius_km: null };
  assert.equal(pickCity({ lat: 41.4036, lng: 2.1744 }, [legacy])?.id, "bcn");
});

// `null <= 15` is true in JavaScript, so an unguarded distance filter would
// make a broken city swallow every shop on earth at "0 km".
test("a city with a broken center never claims a shop", () => {
  const broken = { ...BARCELONA, id: "broken", center_lat: NaN, center_lng: 2.1 };
  assert.equal(pickCity({ lat: 41.4036, lng: 2.1744 }, [broken]), null);
});

test("no cities at all is not an error, just no match", () => {
  assert.equal(pickCity({ lat: 41.4, lng: 2.17 }, []), null);
});

// --- the row we write ----------------------------------------------------

const input = {
  place_id: "ChIJ_real_google_id",
  name: "Fleurs de Marie",
  address: "12 Rue Sainte-Catherine, Bordeaux",
  lat: 44.84, lng: -0.58,
  website_url: "https://fleursdemarie-demo.fr",
  phone_web: "+33556000000",
  business_hours: { mon: "09:00-13:00,16:00-20:00" },
  phone_mobile: "+33600000000",
  owner_name: "Marie",
  email: null,
  delivery_radius_km: 10,
  trust_tier: "established",
  lifecycle_stage: "production",
  source_notes: "Partner since 2024, we WhatsApp them directly.",
  added_by: "staff@fc.example.com",
};

test("the row carries the REAL Google place_id, so a later scrape updates it instead of twinning it", () => {
  assert.equal(buildManualFloristRow(input, "city-1").place_id, "ChIJ_real_google_id");
});

// Setting joined_at here would hand the florist a link that greets them with
// "you're already in the network" and no form.
test("joined_at is never set at creation — the florist joins by completing the form", () => {
  assert.equal("joined_at" in buildManualFloristRow(input, "city-1"), false);
});

// Null enrichment_notes is exactly what makes the worker's repair sweep pick
// this row up; writing anything there would opt it out of enrichment.
test("enrichment_notes is left unset, which is what makes the row a repair target", () => {
  assert.equal("enrichment_notes" in buildManualFloristRow(input, "city-1"), false);
});

test("source is 'existing', not 'new' — we are not discovering these shops", () => {
  const row = buildManualFloristRow(input, "city-1");
  assert.equal(row.source, "existing");
  assert.equal(row.added_by, "staff@fc.example.com");
});

test("has_website is derived from the url rather than trusted from the caller", () => {
  assert.equal(buildManualFloristRow(input, "c").has_website, true);
  assert.equal(buildManualFloristRow({ ...input, website_url: null }, "c").has_website, false);
});

// These two are what ingest-worker/src/match.ts::passesHardFilter demands.
test("the row carries the two fields without which it could never be matched", () => {
  const row = buildManualFloristRow(input, "c");
  assert.equal(row.delivery_radius_km, 10);
  assert.equal(row.trust_tier, "established");
});

// --- validation ----------------------------------------------------------

const body = { ...input, business_hours: null };

test("accepts a complete submission", () => {
  assert.equal(validateManualFlorist(body).ok, true);
});

// A blank place_id is no longer a rejection — it is the off-maps path, and it
// synthesises one (see below). What still cannot be waived is the geography:
// without coordinates the matcher can never see this florist.
test("rejects a submission with no geography behind it", () => {
  assert.equal(validateManualFlorist({ ...body, lat: null }).ok, false);
  assert.equal(validateManualFlorist({ ...body, lng: "2.1" }).ok, false);
  assert.equal(validateManualFlorist({ ...body, lat: 91, lng: 2 }).ok, false);
  assert.equal(validateManualFlorist({ ...body, place_id: "  " }).ok, true);
});

test("rejects the fields whose absence would make the florist unmatchable", () => {
  assert.equal(validateManualFlorist({ ...body, delivery_radius_km: 0 }).ok, false);
  assert.equal(validateManualFlorist({ ...body, delivery_radius_km: 500 }).ok, false);
  assert.equal(validateManualFlorist({ ...body, trust_tier: "" }).ok, false);
});

test("trims free text and turns blanks into null rather than empty strings", () => {
  const r = validateManualFlorist({ ...body, owner_name: "  Marie  ", source_notes: "   " });
  assert.equal(r.values.owner_name, "Marie");
  assert.equal(r.values.source_notes, null);
});

// --- shops with no Google listing ----------------------------------------
// Plenty of real florists have none: older shops, ones inside a market hall,
// ones whose listing was never claimed.

test("a shop with no Maps pick still gets a place_id, marked as ours", () => {
  const r = validateManualFlorist({ ...body, place_id: "" });
  assert.equal(r.ok, true);
  assert.equal(isManualPlaceId(r.values.place_id), true);
  assert.match(r.values.place_id, /^MANUAL-[0-9a-f-]{36}$/);
});

test("two off-maps shops never collide on the synthesised key", () => {
  const a = validateManualFlorist({ ...body, place_id: "" }).values.place_id;
  const b = validateManualFlorist({ ...body, place_id: "" }).values.place_id;
  assert.notEqual(a, b);
});

test("a real Google id is never overwritten by a synthesised one", () => {
  assert.equal(validateManualFlorist(body).values.place_id, "ChIJ_real_google_id");
  assert.equal(isManualPlaceId("ChIJ_real_google_id"), false);
});

// Coordinates stay mandatory even off-maps: matching loads candidates by a
// bounding box, so a florist without them is invisible to it — they would look
// healthy in the roster and never receive a single order.
test("an off-maps shop still cannot be created without coordinates", () => {
  const r = validateManualFlorist({ ...body, place_id: "", lat: null, lng: null });
  assert.equal(r.ok, false);
  assert.match(r.error, /[Cc]oordinates are required/);
});

// --- reachability ---------------------------------------------------------
// Offers go out by SMS and email. A florist with neither is unreachable, which
// is the same silent failure as missing coordinates: healthy-looking row, no
// orders ever.

test("a florist with no mobile and no email is refused", () => {
  const r = validateManualFlorist({ ...body, phone_mobile: "", email: "" });
  assert.equal(r.ok, false);
  assert.match(r.error, /mobile number or an email/);
});

test("either channel on its own is enough", () => {
  assert.equal(validateManualFlorist({ ...body, phone_mobile: "+33612000111", email: "" }).ok, true);
  assert.equal(validateManualFlorist({ ...body, phone_mobile: "", email: "hola@shop.com" }).ok, true);
});

test("a malformed email is refused rather than stored unusable", () => {
  assert.equal(validateManualFlorist({ ...body, phone_mobile: "", email: "not-an-email" }).ok, false);
});
