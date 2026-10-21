import test from "node:test";
import assert from "node:assert/strict";
import { resolveDemoSink } from "./demoSink.ts";

test("blocks with no settings row at all", () => {
  const r = resolveDemoSink(null);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no-test-email");
});

test("blocks when test_email is unset, empty, or whitespace", () => {
  for (const test_email of [undefined, null, "", "   "]) {
    const r = resolveDemoSink({ test_email });
    assert.equal(r.ok, false, JSON.stringify(test_email));
    assert.equal(r.reason, "no-test-email");
  }
});

test("blocks a malformed test_email rather than silently sending nowhere", () => {
  for (const test_email of ["not-an-email", "foo@", "@bar.com", "foo bar@baz.com"]) {
    const r = resolveDemoSink({ test_email });
    assert.equal(r.ok, false, test_email);
    assert.equal(r.reason, "invalid-test-email");
  }
});

test("resolves the sink when test_email is valid, phone optional", () => {
  const r1 = resolveDemoSink({ test_email: "staff@facundo.test" });
  assert.equal(r1.ok, true);
  assert.equal(r1.sink.email, "staff@facundo.test");
  assert.equal(r1.sink.phone, null);

  const r2 = resolveDemoSink({ test_email: "staff@facundo.test", test_phone: "+34600000000" });
  assert.equal(r2.ok, true);
  assert.equal(r2.sink.phone, "+34600000000");
});

test("trims surrounding whitespace but never fabricates an address", () => {
  const r = resolveDemoSink({ test_email: "  staff@facundo.test  ", test_phone: "  +34600000000  " });
  assert.equal(r.ok, true);
  assert.equal(r.sink.email, "staff@facundo.test");
  assert.equal(r.sink.phone, "+34600000000");
});
