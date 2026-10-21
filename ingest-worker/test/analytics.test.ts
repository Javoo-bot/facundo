import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureAutomationEvent, installAutomationErrorSink, ORDER_AUTOMATION_FAILED } from "../src/analytics";
import { captureError, setErrorSink } from "../src/monitor";
import type { Env } from "../src/types";

function fakeEnv(overrides: Partial<Env> = {}): Env {
  return { ...overrides } as Env;
}

afterEach(() => {
  setErrorSink(null);
  vi.unstubAllGlobals();
});

describe("captureAutomationEvent", () => {
  it("no-ops (no fetch) when POSTHOG_PROJECT_TOKEN is unset", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await captureAutomationEvent(fakeEnv(), "order_match_failed", "order-1", { foo: "bar" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs the expected payload shape to PostHog's capture endpoint when a token is set", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);

    await captureAutomationEvent(
      fakeEnv({ POSTHOG_PROJECT_TOKEN: "phc_test", POSTHOG_HOST: "https://ph.example.com" }),
      "order_match_failed",
      "order-1",
      { city_id: "city-9" },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://ph.example.com/capture/");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      api_key: "phc_test",
      event: "order_match_failed",
      distinct_id: "order-1",
      properties: { city_id: "city-9", source: "ingest-worker", environment: "production" },
    });
  });

  it("tags events environment=garden when POSTHOG_ENVIRONMENT says so, and a caller cannot override it", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);

    await captureAutomationEvent(
      fakeEnv({ POSTHOG_PROJECT_TOKEN: "phc_test", POSTHOG_ENVIRONMENT: "garden" }),
      "order_match_failed",
      "order-1",
      { environment: "production" },
    );

    expect(JSON.parse(fetchSpy.mock.calls[0][1].body as string).properties.environment).toBe("garden");
  });

  it("defaults to PostHog's EU host when POSTHOG_HOST is unset", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);

    await captureAutomationEvent(fakeEnv({ POSTHOG_PROJECT_TOKEN: "phc_test" }), "order_match_failed", "order-1");

    expect(fetchSpy.mock.calls[0][0]).toBe("https://eu.i.posthog.com/capture/");
  });

  it("never throws when PostHog responds with a non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      captureAutomationEvent(fakeEnv({ POSTHOG_PROJECT_TOKEN: "phc_test" }), "order_match_failed", "order-1"),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it("never throws when the fetch itself rejects (PostHog unreachable)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      captureAutomationEvent(fakeEnv({ POSTHOG_PROJECT_TOKEN: "phc_test" }), "order_match_failed", "order-1"),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});

describe("installAutomationErrorSink", () => {
  function fakeCtx() {
    const waited: Promise<unknown>[] = [];
    return { ctx: { waitUntil: (p: Promise<unknown>) => waited.push(p) } as unknown as ExecutionContext, waited };
  }

  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it("mirrors an order-automation captureError context to a PostHog event", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);
    const { ctx, waited } = fakeCtx();

    installAutomationErrorSink(fakeEnv({ POSTHOG_PROJECT_TOKEN: "phc_test" }), ctx);
    captureError("webhook.hmac", new Error("bad signature"));
    await Promise.all(waited);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.event).toBe(ORDER_AUTOMATION_FAILED);
    expect(body.properties).toMatchObject({ context: "webhook.hmac", message: "bad signature" });
  });

  it("forwards a failing payout-reconcile sweep — the money-reconciliation cron is order automation", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);
    const { ctx, waited } = fakeCtx();

    installAutomationErrorSink(fakeEnv({ POSTHOG_PROJECT_TOKEN: "phc_test" }), ctx);
    captureError("cron.payout_reconcile", new Error("dashboard 500"));
    await Promise.all(waited);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.properties).toMatchObject({ context: "cron.payout_reconcile", message: "dashboard 500" });
  });

  it("does not forward a non-order-automation context (e.g. the city-ingest cron claim)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);
    const { ctx, waited } = fakeCtx();

    installAutomationErrorSink(fakeEnv({ POSTHOG_PROJECT_TOKEN: "phc_test" }), ctx);
    captureError("cron.claim_ingest_jobs", new Error("boom"));
    await Promise.all(waited);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still logs to console — installing the mirror does not swallow captureError's own default behavior", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { ctx } = fakeCtx();

    installAutomationErrorSink(fakeEnv({ POSTHOG_PROJECT_TOKEN: "phc_test" }), ctx);
    captureError("webhook.parse", new Error("bad json"));

    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it("logs to console for a non-order-automation context too (mirror, not filter, on the console leg)", () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { ctx } = fakeCtx();

    installAutomationErrorSink(fakeEnv({ POSTHOG_PROJECT_TOKEN: "phc_test" }), ctx);
    captureError("cron.claim_ingest_jobs", new Error("boom"));

    expect(errSpy).toHaveBeenCalledTimes(1);
  });
});
