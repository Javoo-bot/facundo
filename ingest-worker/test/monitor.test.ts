import { describe, expect, it, vi, afterEach } from "vitest";
import { captureError, setErrorSink } from "../src/monitor";

describe("captureError", () => {
  afterEach(() => {
    setErrorSink(null);
  });

  it("routes to a registered sink", () => {
    const events: unknown[] = [];
    setErrorSink((event) => events.push(event));

    captureError("test-context", new Error("boom"));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ context: "test-context", message: "boom" });
  });

  it("keeps a plain Supabase error object's message", () => {
    const events: unknown[] = [];
    setErrorSink((event) => events.push(event));

    captureError("supabase-context", {
      message: "new row violates check constraint",
      code: "23514",
      details: "kind=chase_photo",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      context: "supabase-context",
      message: "new row violates check constraint",
    });
  });

  it("serializes plain objects without message instead of logging [object Object]", () => {
    const events: unknown[] = [];
    setErrorSink((event) => events.push(event));

    captureError("plain-object-context", { code: "PGRST204", details: "block_reason missing" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ context: "plain-object-context" });
    expect((events[0] as { message: string }).message).toContain("PGRST204");
    expect((events[0] as { message: string }).message).not.toBe("[object Object]");
  });

  it("falls back to console.error when the registered sink throws", () => {
    setErrorSink(() => {
      throw new Error("sink is down");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      captureError("test-context", new Error("original failure"));

      expect(spy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(spy.mock.calls[0][0] as string);
      expect(payload.context).toBe("test-context");
      expect(payload.message).toBe("original failure");
    } finally {
      spy.mockRestore();
    }
  });
});
