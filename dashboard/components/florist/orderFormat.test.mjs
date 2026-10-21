// dialableNumber — what the copy button on the post-accept florist work order
// puts on the clipboard (components/florist/FloristOrderDetail.tsx::
// RecipientPhone). The florist READS the stored string unchanged; only the
// copied value is normalised, so a paste never carries brackets or spaces into
// a phone app. The number is whatever Shopify's checkout collected, so the
// interesting cases are all about input we do not control.
//
// Run with: node --test components/florist/orderFormat.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { dialableNumber } from "./orderFormat.ts";

// The shapes below are the ones that actually occur. Checked against every
// order ingested (6,782 rows, 2026-09-14): the only non-digit characters
// present are "+", "(", ")" and space.
test("dialableNumber strips the formatting real Shopify numbers carry", () => {
  assert.equal(dialableNumber("+34 600 123 456"), "+34600123456");
  assert.equal(dialableNumber("(020) 7946 0958"), "02079460958");
  assert.equal(dialableNumber("  +49 30 900001  "), "+4930900001");
  assert.equal(dialableNumber("600123456"), "600123456"); // national form, ~52% of rows
});

// A cross-border order is the normal case here, and a number without its "+"
// is a DIFFERENT number rather than a visible failure.
test("dialableNumber keeps a leading + so an international number stays callable", () => {
  assert.equal(dialableNumber("+351 21 123 4567"), "+351211234567");
  assert.ok(dialableNumber("+34600123456").startsWith("+"));
});

test("dialableNumber refuses a double entry rather than mashing two numbers into one", () => {
  // No row does this today. If one ever does, showing no phone control is
  // strictly better than copying a plausible-looking number that rings a
  // stranger — the florist still has the order chat.
  assert.equal(dialableNumber("+34 600 111 222 / +34 600 333 444"), null);
  assert.equal(dialableNumber("+34600111222+34600333444"), null);
});

test("dialableNumber returns null when nothing usable survives, so no phone control renders", () => {
  assert.equal(dialableNumber(null), null);
  assert.equal(dialableNumber(undefined), null);
  assert.equal(dialableNumber(""), null);
  assert.equal(dialableNumber("   "), null);
  assert.equal(dialableNumber("n/a"), null);
  assert.equal(dialableNumber("+"), null);
  assert.equal(dialableNumber("---"), null);
});

test("dialableNumber refuses a non-string rather than coercing it", () => {
  assert.equal(dialableNumber(34600123456), null);
  assert.equal(dialableNumber({ phone: "+34600123456" }), null);
  assert.equal(dialableNumber(["+34600123456"]), null);
});

// The copied value is normalised but the DISPLAYED one is not, so these must
// stay different for a formatted number — that difference is the whole point.
test("dialableNumber normalises only the copy value, never the stored string", () => {
  const stored = "(020) 7946 0958";
  assert.notEqual(dialableNumber(stored), stored);
  assert.equal(dialableNumber(stored), "02079460958");
});
