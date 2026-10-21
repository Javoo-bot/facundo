import test from "node:test";
import assert from "node:assert/strict";
import { resolveFloristSmsPhone, countryToRegion, normalizePhone } from "./phone.ts";

test("normalizes a national Spanish mobile to E.164", () => {
  assert.equal(resolveFloristSmsPhone({ phone_web: "612 34 56 78" }, "ES"), "+34612345678");
});

test("normalizes a national French mobile to E.164", () => {
  assert.equal(resolveFloristSmsPhone({ phone_web: "06 12 34 56 78" }, "FR"), "+33612345678");
});

test("passes an already-E.164 number through unchanged, even with no region", () => {
  assert.equal(resolveFloristSmsPhone({ phone_web: "+34612345678" }, null), "+34612345678");
});

test("strips punctuation and spacing", () => {
  assert.equal(resolveFloristSmsPhone({ phone_web: "(+34) 612-34.56.78" }, "ES"), "+34612345678");
});

test("prefers phone_web over phone_maps", () => {
  const got = resolveFloristSmsPhone({ phone_web: "+34612345678", phone_maps: "+34699999999" }, "ES");
  assert.equal(got, "+34612345678");
});

test("falls back to phone_maps when phone_web is absent", () => {
  assert.equal(resolveFloristSmsPhone({ phone_maps: "+34699999999" }, "ES"), "+34699999999");
});

test("falls back to phone_maps when phone_web is present but unparseable", () => {
  const got = resolveFloristSmsPhone({ phone_web: "call us!", phone_maps: "+34699999999" }, "ES");
  assert.equal(got, "+34699999999");
});

test("returns null when both numbers are missing", () => {
  assert.equal(resolveFloristSmsPhone({}, "ES"), null);
  assert.equal(resolveFloristSmsPhone({ phone_web: null, phone_maps: null }, "ES"), null);
});

test("returns null for unparseable input rather than guessing", () => {
  assert.equal(resolveFloristSmsPhone({ phone_web: "not a phone" }, "ES"), null);
  assert.equal(resolveFloristSmsPhone({ phone_web: "" }, "ES"), null);
});

test("returns null for a national number when no region is known", () => {
  // "612345678" is meaningless without a country — must not be guessed at.
  assert.equal(resolveFloristSmsPhone({ phone_web: "612 34 56 78" }, null), null);
});

test("returns a landline (we cannot detect SMS-capability reliably; Twilio reports the failure)", () => {
  assert.equal(resolveFloristSmsPhone({ phone_web: "972 20 00 00" }, "ES"), "+34972200000");
});

test("countryToRegion resolves a free-text country name to its alpha-2 code", () => {
  assert.equal(countryToRegion("Spain"), "ES");
  assert.equal(countryToRegion("United States"), "US");
  assert.equal(countryToRegion("UK"), "GB");
});

test("countryToRegion passes an already-alpha-2 code through, case-insensitively", () => {
  assert.equal(countryToRegion("ES"), "ES");
  assert.equal(countryToRegion("es"), "ES");
});

test("countryToRegion resolves an alpha-3 code to alpha-2", () => {
  assert.equal(countryToRegion("ESP"), "ES");
});

test("countryToRegion returns null for an unresolvable/empty/missing country rather than guessing", () => {
  assert.equal(countryToRegion("Narnia"), null);
  assert.equal(countryToRegion(""), null);
  assert.equal(countryToRegion(null), null);
});

test("end-to-end: a national Spanish number with cities.country stored as the free-text name 'Spain' (not 'ES') now resolves, closing the bug where a whole city's SMS silently died", () => {
  assert.equal(resolveFloristSmsPhone({ phone_web: "612 34 56 78" }, countryToRegion("Spain")), "+34612345678");
});

test("prefers phone_mobile — the only number a florist actually confirmed — over both scraped columns", () => {
  const got = resolveFloristSmsPhone(
    { phone_mobile: "+34611111111", phone_web: "+34622222222", phone_maps: "+34633333333" },
    "ES"
  );
  assert.equal(got, "+34611111111");
});

test("falls through to phone_web when phone_mobile is absent", () => {
  assert.equal(resolveFloristSmsPhone({ phone_web: "+34622222222" }, "ES"), "+34622222222");
});

test("falls through to phone_web when phone_mobile is present but unparseable", () => {
  const got = resolveFloristSmsPhone({ phone_mobile: "ask at the counter", phone_web: "+34622222222" }, "ES");
  assert.equal(got, "+34622222222");
});

test("normalizePhone returns null rather than echoing back something unsendable", () => {
  assert.equal(normalizePhone("ask at the counter", "ES"), null);
  assert.equal(normalizePhone("", "ES"), null);
  assert.equal(normalizePhone(null, "ES"), null);
  assert.equal(normalizePhone("612 34 56 78", "ES"), "+34612345678");
});
