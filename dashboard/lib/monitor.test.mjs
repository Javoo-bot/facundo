import test from "node:test";
import assert from "node:assert/strict";
import { captureError, setErrorSink } from "./monitor.ts";

test("captureError: routes to a registered sink", () => {
  const events = [];
  setErrorSink((event) => events.push(event));
  try {
    captureError("test-context", new Error("boom"));
    assert.equal(events.length, 1);
    assert.equal(events[0].context, "test-context");
    assert.equal(events[0].message, "boom");
  } finally {
    setErrorSink(null);
  }
});

test("captureError: keeps a plain Supabase error object's message", () => {
  const events = [];
  setErrorSink((event) => events.push(event));
  try {
    captureError("supabase-context", { message: "new row violates check constraint", code: "23514", details: "kind=chase_photo" });
    assert.equal(events.length, 1);
    assert.equal(events[0].message, "new row violates check constraint");
  } finally {
    setErrorSink(null);
  }
});

test("captureError: serializes plain objects without message instead of logging [object Object]", () => {
  const events = [];
  setErrorSink((event) => events.push(event));
  try {
    captureError("plain-object-context", { code: "PGRST204", details: "block_reason missing" });
    assert.equal(events.length, 1);
    assert.match(events[0].message, /PGRST204/);
    assert.notEqual(events[0].message, "[object Object]");
  } finally {
    setErrorSink(null);
  }
});

test("captureError: a throwing sink falls back to console.error instead of swallowing", () => {
  setErrorSink(() => {
    throw new Error("sink is down");
  });
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    captureError("test-context", new Error("original failure"));
    assert.equal(logged.length, 1);
    const payload = JSON.parse(logged[0][0]);
    assert.equal(payload.context, "test-context");
    assert.equal(payload.message, "original failure");
  } finally {
    console.error = original;
    setErrorSink(null);
  }
});
