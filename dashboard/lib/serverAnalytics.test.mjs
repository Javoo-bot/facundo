import test from "node:test";
import assert from "node:assert/strict";
import { captureServerEvent, installServerErrorSink, DASHBOARD_SERVER_ERROR } from "./serverAnalytics.ts";
import { captureError, setErrorSink } from "./monitor.ts";

const ORIGINAL_TOKEN = process.env.POSTHOG_PROJECT_TOKEN;
const ORIGINAL_HOST = process.env.POSTHOG_HOST;
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CONSOLE_ERROR = console.error;

function restoreEnv() {
  if (ORIGINAL_TOKEN === undefined) delete process.env.POSTHOG_PROJECT_TOKEN;
  else process.env.POSTHOG_PROJECT_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_HOST === undefined) delete process.env.POSTHOG_HOST;
  else process.env.POSTHOG_HOST = ORIGINAL_HOST;
  globalThis.fetch = ORIGINAL_FETCH;
  console.error = ORIGINAL_CONSOLE_ERROR;
  setErrorSink(null);
}

test("captureServerEvent: no-ops (no fetch) when POSTHOG_PROJECT_TOKEN is unset", async () => {
  delete process.env.POSTHOG_PROJECT_TOKEN;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true };
  };
  try {
    await captureServerEvent("some_event", "system", { foo: "bar" });
    assert.equal(calls, 0);
  } finally {
    restoreEnv();
  }
});

test("captureServerEvent: POSTs the expected payload shape to PostHog's capture endpoint when a token is set", async () => {
  process.env.POSTHOG_PROJECT_TOKEN = "phc_test";
  process.env.POSTHOG_HOST = "https://ph.example.com";
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([url, init]);
    return { ok: true };
  };
  try {
    await captureServerEvent("dashboard_server_error", "system", { context: "payout.failed" });

    assert.equal(calls.length, 1);
    const [url, init] = calls[0];
    assert.equal(url, "https://ph.example.com/capture/");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["content-type"], "application/json");
    const body = JSON.parse(init.body);
    assert.equal(body.api_key, "phc_test");
    assert.equal(body.event, "dashboard_server_error");
    assert.equal(body.distinct_id, "system");
    assert.equal(body.properties.context, "payout.failed");
    assert.equal(body.properties.source, "dashboard");
    assert.equal(body.properties.environment, "production");
  } finally {
    restoreEnv();
  }
});

test("captureServerEvent: tags environment=garden when POSTHOG_ENVIRONMENT says so, and a caller cannot override it", async () => {
  process.env.POSTHOG_PROJECT_TOKEN = "phc_test";
  process.env.POSTHOG_ENVIRONMENT = "garden";
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([url, init]);
    return { ok: true };
  };
  try {
    await captureServerEvent("recruit_email_sent", "florist-1", { environment: "production" });
    assert.equal(JSON.parse(calls[0][1].body).properties.environment, "garden");
  } finally {
    delete process.env.POSTHOG_ENVIRONMENT;
    restoreEnv();
  }
});

test("captureServerEvent: defaults to PostHog's EU host when POSTHOG_HOST is unset", async () => {
  process.env.POSTHOG_PROJECT_TOKEN = "phc_test";
  delete process.env.POSTHOG_HOST;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([url, init]);
    return { ok: true };
  };
  try {
    await captureServerEvent("dashboard_server_error", "system");
    assert.equal(calls[0][0], "https://eu.i.posthog.com/capture/");
  } finally {
    restoreEnv();
  }
});

test("captureServerEvent: never throws when PostHog responds with a non-ok status", async () => {
  process.env.POSTHOG_PROJECT_TOKEN = "phc_test";
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    await assert.doesNotReject(() => captureServerEvent("dashboard_server_error", "system"));
    assert.equal(logged.length, 1);
  } finally {
    restoreEnv();
  }
});

test("captureServerEvent: never throws when the fetch itself rejects (PostHog unreachable)", async () => {
  process.env.POSTHOG_PROJECT_TOKEN = "phc_test";
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    await assert.doesNotReject(() => captureServerEvent("dashboard_server_error", "system"));
    assert.equal(logged.length, 1);
  } finally {
    restoreEnv();
  }
});

test("captureServerEvent: never logs the token or host in its own error payload", async () => {
  process.env.POSTHOG_PROJECT_TOKEN = "phc_super-secret-token";
  process.env.POSTHOG_HOST = "https://secret-host.example.com";
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    await captureServerEvent("dashboard_server_error", "system");
    const serialized = JSON.stringify(logged);
    assert.equal(serialized.includes("phc_super-secret-token"), false);
    assert.equal(serialized.includes("secret-host.example.com"), false);
  } finally {
    restoreEnv();
  }
});

test("installServerErrorSink: mirrors a captureError call to a PostHog event with redacted properties (no stack)", async () => {
  process.env.POSTHOG_PROJECT_TOKEN = "phc_test";
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([url, init]);
    return { ok: true };
  };
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    installServerErrorSink();
    captureError("payout.failed", new Error("insufficient funds"));

    // The POST happens fire-and-forget inside the sink; give its microtask a turn.
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.ok(logged.length >= 1, "still logs to console — the mirror does not replace it");

    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0][1].body);
    assert.equal(body.event, DASHBOARD_SERVER_ERROR);
    assert.deepEqual(Object.keys(body.properties).sort(), ["context", "environment", "message", "source"]);
    assert.equal(body.properties.context, "payout.failed");
    assert.equal(body.properties.message, "insufficient funds");
    assert.equal("stack" in body.properties, false);
  } finally {
    restoreEnv();
  }
});

test("installServerErrorSink: still logs to console (no fetch) when POSTHOG_PROJECT_TOKEN is unset", async () => {
  delete process.env.POSTHOG_PROJECT_TOKEN;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true };
  };
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    installServerErrorSink();
    captureError("waves.file_escalate", new Error("boom"));

    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(logged.length, 1);
    assert.equal(calls, 0);
  } finally {
    restoreEnv();
  }
});

test("installServerErrorSink: a captureError call still returns synchronously and never throws", () => {
  process.env.POSTHOG_PROJECT_TOKEN = "phc_test";
  globalThis.fetch = async () => {
    throw new Error("posthog is down");
  };
  console.error = () => {};
  try {
    installServerErrorSink();
    assert.doesNotThrow(() => captureError("payout.failed", new Error("insufficient funds")));
  } finally {
    restoreEnv();
  }
});
