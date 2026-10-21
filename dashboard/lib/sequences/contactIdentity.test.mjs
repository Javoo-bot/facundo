import test from "node:test";
import assert from "node:assert/strict";
import { contactKey, shouldEnrolContact } from "./contactIdentity.ts";

test("case and whitespace are folded", () => {
  assert.equal(contactKey("  Contact@Reseau-demo.fr "), "contact@reseau-demo.fr");
  assert.equal(contactKey("contact@reseau-demo.fr"), "contact@reseau-demo.fr");
});

// Deliberately NOT folded: for a business, the local part usually means
// something, and merging two real inboxes silently drops a prospect.
test("dots and +tags are preserved — they can be different mailboxes", () => {
  assert.notEqual(contactKey("info.paris@shop.fr"), contactKey("infoparis@shop.fr"));
  assert.notEqual(contactKey("info+orders@shop.fr"), contactKey("info@shop.fr"));
});

test("anything that isn't an address is not an identity", () => {
  for (const v of [null, undefined, "", "   ", "not-an-email", "a@b", "@shop.fr", "info@", 42, {}]) {
    assert.equal(contactKey(v), null, JSON.stringify(v));
  }
});

// The real case from live data: contact@reseau-demo.fr is on 33 listings. Without
// this, one funnel puts 4 emails x 33 into a single inbox.
test("a second listing sharing an inbox is not enrolled", () => {
  const live = new Set(["contact@reseau-demo.fr"]);
  assert.equal(shouldEnrolContact("contact@reseau-demo.fr", live), false);
  assert.equal(shouldEnrolContact("  CONTACT@Reseau-demo.fr  ", live), false, "same inbox, different casing");
});

test("a different shop is unaffected", () => {
  const live = new Set(["contact@reseau-demo.fr"]);
  assert.equal(shouldEnrolContact("hola@floresdemo.es", live), true);
});

// A refusal here would be silent. The tick logs its own `no-email` skip with a
// reason, which is the more useful trace.
test("a shop with no usable address is allowed through to the tick's own skip", () => {
  assert.equal(shouldEnrolContact(null, new Set(["contact@reseau-demo.fr"])), true);
  assert.equal(shouldEnrolContact("junk", new Set()), true);
});

test("an empty live set enrols everyone", () => {
  assert.equal(shouldEnrolContact("hola@floresdemo.es", []), true);
});
