import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDraft } from "./outreach.ts";

test("parseDraft splits subject + body", () => {
  const r = parseDraft("Subject: Partnering with Facundo — Boston florists\n\nHi there,\n\nI came across Fern...");
  assert.equal(r.subject, "Partnering with Facundo — Boston florists");
  assert.ok(r.body.startsWith("Hi there,"));
});

test("parseDraft falls back when no Subject line", () => {
  const r = parseDraft("Hello, no subject here.");
  assert.equal(r.subject, "Partnering with Facundo");
  assert.equal(r.body, "Hello, no subject here.");
});

test("parseDraft handles null", () => {
  const r = parseDraft(null);
  assert.equal(r.subject, "Partnering with Facundo");
  assert.equal(r.body, "");
});
