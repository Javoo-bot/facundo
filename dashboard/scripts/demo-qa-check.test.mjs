import test from "node:test";
import assert from "node:assert/strict";
import { resolveLiveGate } from "./demo-qa-check.mjs";

test("resolveLiveGate: refuses when nothing is set", () => {
  const gate = resolveLiveGate({});
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /FACUNDO_DEMO_QA_BASE_URL/);
});

test("resolveLiveGate: refuses when base url is set but live is not explicitly allowed", () => {
  const gate = resolveLiveGate({ FACUNDO_DEMO_QA_BASE_URL: "http://localhost:3001" });
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /ALLOW_LIVE/);
});

test("resolveLiveGate: a truthy-looking but non-'1' ALLOW_LIVE still refuses (fail closed)", () => {
  for (const v of ["true", "yes", "TRUE", "01", ""]) {
    const gate = resolveLiveGate({ FACUNDO_DEMO_QA_BASE_URL: "http://localhost:3001", FACUNDO_DEMO_QA_ALLOW_LIVE: v });
    assert.equal(gate.ok, false, `ALLOW_LIVE=${JSON.stringify(v)} must not be accepted`);
  }
});

test("resolveLiveGate: refuses when the base url and allow-live are set but no session cookie is provided", () => {
  const gate = resolveLiveGate({ FACUNDO_DEMO_QA_BASE_URL: "http://localhost:3001", FACUNDO_DEMO_QA_ALLOW_LIVE: "1" });
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /SESSION_COOKIE/);
});

test("resolveLiveGate: succeeds only once all three are set, and trims a trailing slash off the base url", () => {
  const gate = resolveLiveGate({
    FACUNDO_DEMO_QA_BASE_URL: "http://localhost:3001/",
    FACUNDO_DEMO_QA_ALLOW_LIVE: "1",
    FACUNDO_DEMO_QA_SESSION_COOKIE: "sb-access-token=abc123",
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.baseUrl, "http://localhost:3001");
  assert.equal(gate.cookie, "sb-access-token=abc123");
});

test("resolveLiveGate: whitespace-only values are treated as unset", () => {
  const gate = resolveLiveGate({
    FACUNDO_DEMO_QA_BASE_URL: "   ",
    FACUNDO_DEMO_QA_ALLOW_LIVE: "1",
    FACUNDO_DEMO_QA_SESSION_COOKIE: "x",
  });
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /FACUNDO_DEMO_QA_BASE_URL/);
});
