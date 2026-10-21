// The transport and the structured-output reader — the two places the
// Anthropic → OpenRouter move could break silently rather than loudly.
import { describe, it, expect, vi, afterEach } from "vitest";
import { MAX_RETRIES, OpenRouterError, chat, isLlmOutage, llmClient } from "../src/openrouter";
import { WORKER_AGENTS } from "../src/agents.generated";
import type { Env } from "../src/types";
import { structured, freeText, EMAIL_SCHEMA } from "../src/llm";
import { UsageTracker } from "../src/usage";

const client = { apiKey: "sk-test" };
const TAG = { agent: "sherlock", name: "email" } as const;
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const toolBody = (args: string) => ({ choices: [{ message: { tool_calls: [{ function: { name: "select_email", arguments: args } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } });

afterEach(() => vi.unstubAllGlobals());

describe("chat transport", () => {
  it("retries 429 and 5xx, then succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(ok({ choices: [{ message: { content: "hi" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await chat(client, { model: "m", max_tokens: 8, messages: [{ role: "user", content: "x" }] }, TAG);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res.choices?.[0]?.message?.content).toBe("hi");
  });

  it("does NOT retry a 4xx — an exhausted account fails once, with its real message", async () => {
    // This is the exact failure that silently emptied three cities' relevance
    // filtering: retrying it three times changes nothing and hides the cause.
    const fetchMock = vi.fn().mockResolvedValue(new Response("credit balance is too low", { status: 402 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(chat(client, { model: "m", max_tokens: 8, messages: [{ role: "user", content: "x" }] }, TAG))
      .rejects.toThrow(/402.*credit balance/s);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after MAX_RETRIES and surfaces the last error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(chat(client, { model: "m", max_tokens: 8, messages: [{ role: "user", content: "x" }] }, TAG)).rejects.toThrow(OpenRouterError);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_RETRIES + 1);
  });

  it("treats a 200 carrying an error body as a failure, not a response", async () => {
    // OpenRouter surfaces upstream provider failures this way.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(ok({ error: { message: "upstream timed out", code: 502 } }))
      .mockResolvedValueOnce(ok({ choices: [{ message: { content: "recovered" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await chat(client, { model: "m", max_tokens: 8, messages: [{ role: "user", content: "x" }] }, TAG);
    expect(res.choices?.[0]?.message?.content).toBe("recovered");
  });

  it("retries a network error / timeout", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }))
      .mockResolvedValueOnce(ok({ choices: [{ message: { content: "second try" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await chat(client, { model: "m", max_tokens: 8, messages: [{ role: "user", content: "x" }] }, TAG);
    expect(res.choices?.[0]?.message?.content).toBe("second try");
  });

  it("always requests usage accounting, so cost is reported rather than guessed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ choices: [{ message: { content: "" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    await chat(client, { model: "m", max_tokens: 8, messages: [{ role: "user", content: "x" }] }, TAG);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).usage).toEqual({ include: true });
  });
});

describe("structured()", () => {
  it("parses tool arguments — they arrive as a JSON STRING, not an object", async () => {
    // Anthropic returned `tool_use.input` already parsed. Passing the OpenAI
    // string through untouched type-checks and then fails later as undefined
    // field reads, so this is the single most valuable assertion in the port.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok(toolBody('{"email":"a@b.com","confidence":0.9}'))));
    const { parsed } = await structured<{ email: string; confidence: number }>(client, "m", "p", EMAIL_SCHEMA, 128, TAG);
    expect(parsed).toEqual({ email: "a@b.com", confidence: 0.9 });
    expect(typeof parsed).toBe("object");
  });

  it("sends the schema as a forced OpenAI function tool", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(toolBody("{}")));
    vi.stubGlobal("fetch", fetchMock);
    await structured(client, "m", "p", EMAIL_SCHEMA, 128, TAG);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools[0].type).toBe("function");
    expect(body.tools[0].function.name).toBe("select_email");
    expect(body.tools[0].function.parameters).toEqual(EMAIL_SCHEMA.parameters);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "select_email" } });
  });

  it("throws with the raw output when the model emits malformed JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok(toolBody('{"email": '))));
    await expect(structured(client, "m", "p", EMAIL_SCHEMA, 128, TAG)).rejects.toThrow(/not valid JSON/);
  });

  it("throws when the model returns no tool call at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ choices: [{ message: { content: "sorry" } }] })));
    await expect(structured(client, "m", "p", EMAIL_SCHEMA, 128, TAG)).rejects.toThrow(/no tool call/);
  });

  it("freeText reads message content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok({ choices: [{ message: { content: "  hello  " } }] })));
    expect((await freeText(client, "m", "p", 64, TAG)).text).toBe("hello");
  });
});

describe("Langfuse trace from chat()", () => {
  const traced = {
    apiKey: "sk-test",
    traceEnv: { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASE_URL: "https://lf.example" },
  };
  const langfuseCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter(([url]) => String(url).startsWith("https://lf.example"));
  const rootAttrs = (call: unknown[]) => {
    const span = JSON.parse((call[1] as { body: string }).body).resourceSpans[0].scopeSpans[0].spans[0];
    return Object.fromEntries(span.attributes.map((a: { key: string; value: Record<string, unknown> }) => [a.key, Object.values(a.value)[0]]));
  };
  const genAttrs = (call: unknown[]) => {
    const span = JSON.parse((call[1] as { body: string }).body).resourceSpans[0].scopeSpans[0].spans[1];
    return Object.fromEntries(span.attributes.map((a: { key: string; value: Record<string, unknown> }) => [a.key, Object.values(a.value)[0]]));
  };

  it("sends nothing without LANGFUSE_* (production)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(toolBody('{"email":null,"confidence":0}')));
    vi.stubGlobal("fetch", fetchMock);
    await structured(client, "m", "the prompt", EMAIL_SCHEMA, 128, TAG);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends one trace per call, named after the agent, with the prompt, tool output, model, usage and rules hash", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith("https://lf.example") ? new Response("", { status: 200 }) : ok(toolBody('{"email":"a@b.com","confidence":0.9}'))
    );
    vi.stubGlobal("fetch", fetchMock);
    await structured(traced, "anthropic/claude-haiku-4.5", "the prompt", EMAIL_SCHEMA, 128, { agent: "sherlock", name: "email", sessionId: "place-1" });
    const sent = langfuseCalls(fetchMock);
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe("https://lf.example/api/public/otel/v1/traces");
    const root = rootAttrs(sent[0]);
    expect(root["langfuse.trace.name"]).toBe("Sherlock");
    expect(root["langfuse.session.id"]).toBe("place-1");
    expect(root["langfuse.trace.input"]).toBe("the prompt");
    expect(JSON.parse(root["langfuse.trace.output"] as string)).toEqual({ email: "a@b.com", confidence: 0.9 });
    expect(root["langfuse.trace.metadata.rules_hash"]).toBe(WORKER_AGENTS.sherlock.rulesHash);
    const gen = genAttrs(sent[0]);
    expect(gen["langfuse.observation.model.name"]).toBe("anthropic/claude-haiku-4.5");
    expect(JSON.parse(gen["langfuse.observation.usage_details"] as string)).toEqual({ input: 10, output: 5 });
    expect(JSON.parse(gen["langfuse.observation.cost_details"] as string)).toEqual({ total: 0.001 });
  });

  it("traces a failed call as an error and still throws the original error", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith("https://lf.example") ? new Response("", { status: 200 }) : new Response("credit balance is too low", { status: 402 })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(chat(traced, { model: "m", max_tokens: 8, messages: [{ role: "user", content: "x" }] }, { agent: "bloom", name: "relevance" }))
      .rejects.toThrow(/402/);
    const sent = langfuseCalls(fetchMock);
    expect(sent).toHaveLength(1);
    const root = rootAttrs(sent[0]);
    expect(root["langfuse.trace.name"]).toBe("Bloom");
    expect(root["langfuse.observation.level"]).toBe("ERROR");
    expect(root["langfuse.observation.status_message"]).toMatch(/402/);
  });

  it("a Langfuse outage never fails the model call", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://lf.example")) throw new Error("langfuse down");
      return ok({ choices: [{ message: { content: "fine" } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await chat(traced, { model: "m", max_tokens: 8, messages: [{ role: "user", content: "x" }] }, { agent: "scout", name: "keywords" });
    expect(res.choices?.[0]?.message?.content).toBe("fine");
  });

  it("llmClient reads LANGFUSE_* from the Worker env", () => {
    const env = { OPENROUTER_API_KEY: "or", LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASE_URL: "u" } as unknown as Env;
    expect(llmClient(env)).toEqual({
      apiKey: "or",
      traceEnv: { LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", LANGFUSE_BASE_URL: "u" },
    });
  });
});

describe("UsageTracker with OpenRouter usage", () => {
  it("reads OpenAI token field names", () => {
    const t = new UsageTracker();
    t.record("email", "anthropic/claude-haiku-4.5", { prompt_tokens: 717, completion_tokens: 60, cost: 0.001017 });
    expect(t.totalInputTokens).toBe(717);
    expect(t.totalOutputTokens).toBe(60);
  });

  it("prefers OpenRouter's reported cost over the fallback table", () => {
    const t = new UsageTracker();
    t.record("email", "anthropic/claude-haiku-4.5", { prompt_tokens: 717, completion_tokens: 60, cost: 0.5 });
    expect(t.costUsd).toBeCloseTo(0.5, 6); // not the table's 0.001017
  });

  it("falls back to the rate table when no cost is reported", () => {
    const t = new UsageTracker();
    t.record("email", "anthropic/claude-haiku-4.5", { prompt_tokens: 717, completion_tokens: 60 });
    // 717/1e6*1.0 + 60/1e6*5.0 — the same arithmetic the live API confirmed.
    expect(t.costUsd).toBeCloseTo(0.001017, 6);
  });

  it("keeps the stored llm_cost_by_type shape unchanged", () => {
    const t = new UsageTracker();
    t.record("relevance", "anthropic/claude-sonnet-5", { prompt_tokens: 100, completion_tokens: 20, cost: 0.004 });
    expect(t.toByTypeDict().relevance).toEqual({
      calls: 1, input_tokens: 100, output_tokens: 20, cost_usd: 0.004, model: "anthropic/claude-sonnet-5",
    });
  });
});

describe("isLlmOutage", () => {
  it("treats no-credit, bad-key and forbidden as the account being down", () => {
    for (const status of [401, 402, 403]) {
      expect(isLlmOutage(new OpenRouterError(`OpenRouter ${status}: nope`, status))).toBe(true);
    }
  });

  it("catches a credit exhaustion that arrives under a non-obvious status", () => {
    // Exactly the 2026-08-06 shape: Anthropic returned this as a 400, which a
    // status check alone waves through as an ordinary bad request. 1,065 rows
    // still carry the text.
    const e = new OpenRouterError(
      "OpenRouter 400: Your credit balance is too low to access the Anthropic API. " +
        "Please go to Plans & Billing to upgrade or purchase credits.",
      400
    );
    expect(isLlmOutage(e)).toBe(true);
  });

  it("leaves ordinary per-call failures isolable", () => {
    // These are the ones per-florist isolation exists for: skip the florist,
    // keep the run.
    expect(isLlmOutage(new OpenRouterError("OpenRouter 400: malformed tool call", 400))).toBe(false);
    expect(isLlmOutage(new OpenRouterError("OpenRouter 429: slow down", 429))).toBe(false);
    expect(isLlmOutage(new OpenRouterError("OpenRouter 500: upstream boom", 500))).toBe(false);
    expect(isLlmOutage(new Error("socket hang up"))).toBe(false);
    expect(isLlmOutage(null)).toBe(false);
  });
});
