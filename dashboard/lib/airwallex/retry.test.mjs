import test from "node:test";
import assert from "node:assert/strict";
import { retryingFetch, isRetryable } from "./retry.ts";

const noSleep = async () => {};
const resp = (status) => new Response("", { status });

// A fake fetch that returns a scripted sequence of responses/errors.
function scripted(seq) {
  let i = 0;
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const step = seq[Math.min(i, seq.length - 1)];
    i++;
    if (step instanceof Error) throw step;
    return step;
  };
  impl.count = () => i;
  impl.calls = calls;
  return impl;
}

test("isRetryable: 429 and 5xx only", () => {
  assert.equal(isRetryable(429), true);
  assert.equal(isRetryable(500), true);
  assert.equal(isRetryable(503), true);
  assert.equal(isRetryable(400), false);
  assert.equal(isRetryable(404), false);
  assert.equal(isRetryable(200), false);
});

test("returns immediately on success (one call)", async () => {
  const f = scripted([resp(200)]);
  const r = await retryingFetch("u", {}, { fetchImpl: f, sleep: noSleep });
  assert.equal(r.status, 200);
  assert.equal(f.count(), 1);
});

test("does NOT retry a 4xx (returns it, one call)", async () => {
  const f = scripted([resp(400)]);
  const r = await retryingFetch("u", {}, { fetchImpl: f, sleep: noSleep });
  assert.equal(r.status, 400);
  assert.equal(f.count(), 1);
});

test("retries a 500 then succeeds", async () => {
  const f = scripted([resp(500), resp(200)]);
  const r = await retryingFetch("u", {}, { fetchImpl: f, sleep: noSleep });
  assert.equal(r.status, 200);
  assert.equal(f.count(), 2);
});

test("retries a 429 then succeeds", async () => {
  const f = scripted([resp(429), resp(200)]);
  const r = await retryingFetch("u", {}, { fetchImpl: f, sleep: noSleep });
  assert.equal(r.status, 200);
  assert.equal(f.count(), 2);
});

test("retries a network error then succeeds", async () => {
  const f = scripted([new Error("ECONNRESET"), resp(200)]);
  const r = await retryingFetch("u", {}, { fetchImpl: f, sleep: noSleep });
  assert.equal(r.status, 200);
  assert.equal(f.count(), 2);
});

test("exhausts retries on persistent 500 -> returns the last 500", async () => {
  const f = scripted([resp(500), resp(500), resp(500)]);
  const r = await retryingFetch("u", {}, { attempts: 3, fetchImpl: f, sleep: noSleep });
  assert.equal(r.status, 500);
  assert.equal(f.count(), 3);
});

test("exhausts retries on persistent network error -> throws last error", async () => {
  const f = scripted([new Error("boom"), new Error("boom"), new Error("boom")]);
  await assert.rejects(
    () => retryingFetch("u", {}, { attempts: 3, fetchImpl: f, sleep: noSleep }),
    /boom/,
  );
  assert.equal(f.count(), 3);
});

test("attempts is clamped to at least 1", async () => {
  const f = scripted([resp(500)]);
  const r = await retryingFetch("u", {}, { attempts: 0, fetchImpl: f, sleep: noSleep });
  assert.equal(r.status, 500);
  assert.equal(f.count(), 1);
});

test("backoff delays grow exponentially from baseDelayMs", async () => {
  const delays = [];
  const f = scripted([resp(500), resp(500), resp(200)]);
  await retryingFetch("u", {}, {
    attempts: 3, baseDelayMs: 10, fetchImpl: f, sleep: async (ms) => { delays.push(ms); },
  });
  assert.deepEqual(delays, [10, 20]); // 10*2^0, 10*2^1
});
