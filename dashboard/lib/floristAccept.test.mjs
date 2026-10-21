import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAcceptSubmission, buildAcceptUpdate, OWNER_NAME_MAX, SHOP_STORY_MAX } from "./floristAccept.ts";

/** The shared minimum a submission needs. The mobile is optional (see the
 * mobile-number block below) but carried here so the other tests exercise the
 * validated-and-present path rather than the absent one. */
const base = (over = {}) => ({
  name: "Shop",
  phone_mobile: "+34612345678",
  next_day_cutoff_hour: 13,
  ...over,
});

test("accepts a full valid submission", () => {
  const result = validateAcceptSubmission({
    name: "Flor Demo BCN",
    owner_name: "Marta Vidal",
    address: "Carrer de Mallorca 245, Barcelona, Spain",
    phone: "+34 933 00 05 67",
    phone_mobile: "+34 612 34 56 78",
    email: "hola@flordemo.com",
    shop_story: "  Third generation on the same street.  ",
    business_hours: { mon: "09:00-19:00", sun: "closed" },
    next_day_cutoff_hour: 13,
    lat: 41.3958,
    lng: 2.1614,
  });
  assert.deepEqual(result, {
    ok: true,
    values: {
      locale: null,
      name: "Flor Demo BCN",
      owner_name: "Marta Vidal",
      address: "Carrer de Mallorca 245, Barcelona, Spain",
      phone: "+34 933 00 05 67",
      phone_mobile: "+34612345678",
      email: "hola@flordemo.com",
      shop_story: "Third generation on the same street.",
      business_hours: { mon: "09:00-19:00", sun: "closed" },
      next_day_cutoff_hour: 13,
      lat: 41.3958,
      lng: 2.1614,
    },
  });
});

test("rejects an empty name", () => {
  assert.equal(validateAcceptSubmission(base({ name: "   " })).ok, false);
});

test("trims name/address/phone and empty-string free-text fields become null", () => {
  const result = validateAcceptSubmission(base({ name: "  Flor Demo BCN  ", address: "   ", phone: "" }));
  assert.equal(result.ok, true);
  assert.equal(result.values.name, "Flor Demo BCN");
  assert.equal(result.values.address, null);
  assert.equal(result.values.phone, null);
});

// --- owner name (the person, not the shop) -------------------------------

test("owner_name is optional and trimmed; blank or absent becomes null", () => {
  assert.equal(validateAcceptSubmission(base({ owner_name: "  Marta Vidal  " })).values.owner_name, "Marta Vidal");
  assert.equal(validateAcceptSubmission(base({ owner_name: "   " })).values.owner_name, null);
  assert.equal(validateAcceptSubmission(base()).values.owner_name, null);
});

test("rejects an owner_name past the length cap", () => {
  assert.equal(validateAcceptSubmission(base({ owner_name: "x".repeat(OWNER_NAME_MAX) })).ok, true);
  assert.equal(validateAcceptSubmission(base({ owner_name: "x".repeat(OWNER_NAME_MAX + 1) })).ok, false);
});

test("rejects a cutoff hour outside the fixed set", () => {
  assert.equal(validateAcceptSubmission(base({ next_day_cutoff_hour: 10 })).ok, false);
});

// --- mobile number -------------------------------------------------------

test("the mobile is optional — a florist with only a landline can still join", () => {
  const result = validateAcceptSubmission({ name: "Shop", next_day_cutoff_hour: 13 });
  assert.equal(result.ok, true);
  assert.equal(result.values.phone_mobile, null);
});

test("a blank mobile is null, not an error", () => {
  const result = validateAcceptSubmission(base({ phone_mobile: "   " }));
  assert.equal(result.ok, true);
  assert.equal(result.values.phone_mobile, null);
});

test("optional does not mean unvalidated — a mobile we could never text is still rejected", () => {
  const result = validateAcceptSubmission(base({ phone_mobile: "call the shop" }));
  assert.equal(result.ok, false);
  assert.match(result.error, /send messages to/);
});

test("normalizes a national mobile to E.164 using the florist's region", () => {
  const result = validateAcceptSubmission(base({ phone_mobile: "612 34 56 78" }), "ES");
  assert.equal(result.ok, true);
  assert.equal(result.values.phone_mobile, "+34612345678");
});

test("a national number with no region to interpret it is rejected, not stored raw", () => {
  // Without a region "612 34 56 78" is unresolvable — storing it would look
  // like a working SMS channel that can never send.
  assert.equal(validateAcceptSubmission(base({ phone_mobile: "612 34 56 78" }), null).ok, false);
});

test("an already-international mobile works with no region", () => {
  const result = validateAcceptSubmission(base({ phone_mobile: "(+34) 612-34.56.78" }), null);
  assert.equal(result.ok, true);
  assert.equal(result.values.phone_mobile, "+34612345678");
});

// --- shop story ----------------------------------------------------------

test("shop_story is trimmed, and blank becomes null", () => {
  assert.equal(validateAcceptSubmission(base({ shop_story: "   " })).values.shop_story, null);
  assert.equal(validateAcceptSubmission(base({ shop_story: "  hi  " })).values.shop_story, "hi");
});

test("shop_story is null when absent", () => {
  assert.equal(validateAcceptSubmission(base()).values.shop_story, null);
});

test("shop_story at the cap is accepted, one over is rejected", () => {
  assert.equal(validateAcceptSubmission(base({ shop_story: "x".repeat(SHOP_STORY_MAX) })).ok, true);
  assert.equal(validateAcceptSubmission(base({ shop_story: "x".repeat(SHOP_STORY_MAX + 1) })).ok, false);
});

// --- coordinates ---------------------------------------------------------

test("absent coordinates are null, not an error", () => {
  const result = validateAcceptSubmission(base());
  assert.equal(result.values.lat, null);
  assert.equal(result.values.lng, null);
});

test("rejects one coordinate without the other", () => {
  assert.equal(validateAcceptSubmission(base({ lat: 41.4 })).ok, false);
  assert.equal(validateAcceptSubmission(base({ lng: 2.1 })).ok, false);
});

test("rejects out-of-range and non-finite coordinates", () => {
  assert.equal(validateAcceptSubmission(base({ lat: 91, lng: 2.1 })).ok, false);
  assert.equal(validateAcceptSubmission(base({ lat: 41.4, lng: 181 })).ok, false);
  assert.equal(validateAcceptSubmission(base({ lat: Number.NaN, lng: 2.1 })).ok, false);
  assert.equal(validateAcceptSubmission(base({ lat: "41.4", lng: "2.1" })).ok, false);
});

test("accepts the null island rather than treating 0,0 as missing", () => {
  const result = validateAcceptSubmission(base({ lat: 0, lng: 0 }));
  assert.equal(result.ok, true);
  assert.equal(result.values.lat, 0);
});

// --- business hours ------------------------------------------------------

test("accepts business_hours: null (florist left it blank)", () => {
  const result = validateAcceptSubmission(base({ business_hours: null }));
  assert.equal(result.ok, true);
  assert.equal(result.values.business_hours, null);
});

test("rejects an unrecognized business_hours day key", () => {
  assert.equal(validateAcceptSubmission(base({ business_hours: { someday: "09:00-19:00" } })).ok, false);
});

test("rejects a business_hours range where close is before open", () => {
  assert.equal(validateAcceptSubmission(base({ business_hours: { mon: "19:00-09:00" } })).ok, false);
});

test("rejects a business_hours value that is neither 'closed' nor a range", () => {
  assert.equal(validateAcceptSubmission(base({ business_hours: { mon: "whenever" } })).ok, false);
});

// --- email ---------------------------------------------------------------

test("accepts a unicode local-part email", () => {
  assert.equal(validateAcceptSubmission(base({ email: "concepciónperez@correo-demo.es" })).ok, true);
});

test("rejects a malformed email", () => {
  assert.equal(validateAcceptSubmission(base({ email: "not-an-email" })).ok, false);
});

// --- update construction -------------------------------------------------

const values = (over = {}) => ({
  locale: null,
  name: "Shop",
  owner_name: null,
  address: null,
  phone: null,
  phone_mobile: "+34612345678",
  email: null,
  shop_story: null,
  business_hours: null,
  next_day_cutoff_hour: 13,
  lat: null,
  lng: null,
  ...over,
});

test("buildAcceptUpdate omits business_hours entirely when the submission has none, so it never clobbers existing data", () => {
  const update = buildAcceptUpdate(values(), "2026-08-03T00:00:00.000Z");
  assert.equal("business_hours" in update, false);
  assert.deepEqual(update, {
    name: "Shop",
    address: null,
    phone_web: null,
    phone_mobile: "+34612345678",
    email: null,
    shop_story: null,
    next_day_cutoff_hour: 13,
    joined_at: "2026-08-03T00:00:00.000Z",
  });
});

test("buildAcceptUpdate includes business_hours when the submission actually set it", () => {
  const update = buildAcceptUpdate(
    values({ business_hours: { mon: "09:00-19:00", sun: "closed" } }),
    "2026-08-03T00:00:00.000Z"
  );
  assert.deepEqual(update.business_hours, { mon: "09:00-19:00", sun: "closed" });
});

test("buildAcceptUpdate omits lat/lng when the address was typed, so a hand-typed address can't wipe the ingest geocode", () => {
  const update = buildAcceptUpdate(values({ address: "Carrer de Mallorca 245" }), "2026-08-03T00:00:00.000Z");
  assert.equal("lat" in update, false);
  assert.equal("lng" in update, false);
});

test("buildAcceptUpdate writes lat/lng when a Places suggestion was picked", () => {
  const update = buildAcceptUpdate(values({ lat: 41.3958, lng: 2.1614 }), "2026-08-03T00:00:00.000Z");
  assert.equal(update.lat, 41.3958);
  assert.equal(update.lng, 2.1614);
});

test("buildAcceptUpdate never writes place_id — it is the ingest dedup key", () => {
  const update = buildAcceptUpdate(values({ lat: 41.3958, lng: 2.1614 }), "2026-08-03T00:00:00.000Z");
  assert.equal("place_id" in update, false);
});

test("buildAcceptUpdate omits phone_mobile when the florist left it blank, so it can't wipe a staff-entered number", () => {
  const update = buildAcceptUpdate(values({ phone_mobile: null }), "2026-08-03T00:00:00.000Z");
  assert.equal("phone_mobile" in update, false);
});

test("buildAcceptUpdate omits owner_name when the florist left it blank, so it can't wipe the ingest-extracted name", () => {
  const update = buildAcceptUpdate(values({ owner_name: null }), "2026-08-03T00:00:00.000Z");
  assert.equal("owner_name" in update, false);
});

test("buildAcceptUpdate writes owner_name when one was given", () => {
  const update = buildAcceptUpdate(values({ owner_name: "Marta Vidal" }), "2026-08-03T00:00:00.000Z");
  assert.equal(update.owner_name, "Marta Vidal");
});

test("buildAcceptUpdate writes phone_mobile when one was given", () => {
  const update = buildAcceptUpdate(values({ phone_mobile: "+34612345678" }), "2026-08-03T00:00:00.000Z");
  assert.equal(update.phone_mobile, "+34612345678");
});

// --- re-running the join form --------------------------------------------
// A florist who mistyped an address or changed their mobile can open their
// link again. That is editing, not joining twice — so it must not rewrite how
// long they have been with us.

test("a re-run preserves the original joined_at rather than restamping it", () => {
  const first = "2026-06-01T09:00:00.000Z";
  const update = buildAcceptUpdate(values(), "2026-08-12T10:00:00.000Z", first);
  assert.equal(update.joined_at, first);
});

test("a first-time join still stamps joined_at with now", () => {
  const now = "2026-08-12T10:00:00.000Z";
  assert.equal(buildAcceptUpdate(values(), now, null).joined_at, now);
  assert.equal(buildAcceptUpdate(values(), now).joined_at, now);
});

// --- language chosen on the form -----------------------------------------
// Picking a language is telling us how to write to you from now on, not just
// how to read this page: it becomes florists.locale, which every later email
// and SMS reads.

test("a supported locale is accepted and an unknown one is refused", () => {
  assert.equal(validateAcceptSubmission(base({ locale: "es" })).values.locale, "es");
  assert.equal(validateAcceptSubmission(base({ locale: "xx" })).ok, false);
  assert.equal(validateAcceptSubmission(base({ locale: "  " })).values.locale, null);
  assert.equal(validateAcceptSubmission(base()).values.locale, null);
});

test("a chosen language is written to the florist", () => {
  const update = buildAcceptUpdate(values({ locale: "pt" }), "2026-08-12T00:00:00.000Z");
  assert.equal(update.locale, "pt");
});

// Otherwise the form would overwrite a locale staff set deliberately with
// whatever we happened to default the page to.
test("an untouched picker leaves the stored locale alone", () => {
  const update = buildAcceptUpdate(values({ locale: null }), "2026-08-12T00:00:00.000Z");
  assert.equal("locale" in update, false);
});
