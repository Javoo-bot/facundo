import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  langfuseConfig, buildTracePayload, sendAgentRun, usageDetails, asText, MAX_ATTRIBUTE_CHARS,
} from "./langfuse.ts";
import { agentSpec } from "./agents/registry.generated.ts";

const ENV = {
  LANGFUSE_PUBLIC_KEY: "pk-lf-test",
  LANGFUSE_SECRET_KEY: "sk-lf-test",
  LANGFUSE_BASE_URL: "https://cloud.langfuse.com/",
};
const OPTS = { env: ENV, service: "facundo-dashboard" };

const IDS = { traceId: "a".repeat(32), rootSpanId: "b".repeat(16), generationSpanIds: ["c".repeat(16), "d".repeat(16)] };

const RUN = {
  agent: agentSpec("concierge"),
  sessionId: "conv-1",
  metadata: { intent: "order_status", confidence: 0.9, escalate: false, escalation_reason: null, guard_action: "escalate" },
  generations: [
    {
      name: "draft",
      model: "anthropic/claude-sonnet-5",
      input: "You are Marta...",
      output: { intent: "order_status", reply_text: "It is due today.", confidence: 0.9 },
      usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280, cost: 0.0048 },
      startedAt: new Date("2026-10-13T10:00:00.000Z"),
      endedAt: new Date("2026-10-13T10:00:02.500Z"),
    },
  ],
};

const attrs = (span) => Object.fromEntries(span.attributes.map((a) => [a.key, Object.values(a.value)[0]]));
const spans = (body) => body.resourceSpans[0].scopeSpans[0].spans;

function recorder(response = { ok: true, status: 200, text: async () => "" }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  return { calls, fetchImpl };
}

test("the env gate needs all three LANGFUSE_* variables", () => {
  assert.deepEqual(langfuseConfig(ENV), {
    publicKey: "pk-lf-test",
    secretKey: "sk-lf-test",
    baseUrl: "https://cloud.langfuse.com",
  });
  for (const key of Object.keys(ENV)) {
    assert.equal(langfuseConfig({ ...ENV, [key]: undefined }), null, `${key} unset`);
    assert.equal(langfuseConfig({ ...ENV, [key]: "" }), null, `${key} empty`);
  }
});

test("with the gate off nothing is sent", async () => {
  const { calls, fetchImpl } = recorder();
  assert.equal(await sendAgentRun(RUN, { env: {}, service: "x", fetchImpl }), null);
  assert.equal(calls.length, 0);
});

test("a run with no model calls sends nothing", async () => {
  const { calls, fetchImpl } = recorder();
  assert.equal(await sendAgentRun({ ...RUN, generations: [] }, { ...OPTS, fetchImpl }), null);
  assert.equal(calls.length, 0);
});

test("with the gate on one OTLP request goes to Langfuse with basic auth", async () => {
  const { calls, fetchImpl } = recorder();
  assert.equal(await sendAgentRun(RUN, { ...OPTS, fetchImpl, ids: IDS }), IDS.traceId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://cloud.langfuse.com/api/public/otel/v1/traces");
  assert.equal(calls[0].init.headers.Authorization, `Basic ${btoa("pk-lf-test:sk-lf-test")}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), buildTracePayload(RUN, IDS, "facundo-dashboard"));
});

test("a rejected or failed send resolves to null instead of throwing", async () => {
  const rejected = recorder({ ok: false, status: 401, text: async () => "bad key" });
  assert.equal(await sendAgentRun(RUN, { ...OPTS, fetchImpl: rejected.fetchImpl }), null);
  const thrown = async () => {
    throw new Error("network down");
  };
  assert.equal(await sendAgentRun(RUN, { ...OPTS, fetchImpl: thrown }), null);
});

test("the trace is named after the agent and carries its stage and rules hash from the registry", () => {
  const [root, generation] = spans(buildTracePayload(RUN, IDS, "facundo-dashboard"));

  assert.equal(root.traceId, IDS.traceId);
  assert.equal(root.parentSpanId, undefined);
  assert.equal(root.name, "concierge.run");
  assert.equal(generation.parentSpanId, IDS.rootSpanId);
  assert.equal(generation.name, "concierge.draft");
  assert.equal(root.startTimeUnixNano, "1791885600000000000");
  assert.equal(root.endTimeUnixNano, "1791885602500000000");

  const t = attrs(root);
  const concierge = agentSpec("concierge");
  assert.equal(t["langfuse.trace.name"], "Concierge");
  assert.equal(t["langfuse.session.id"], "conv-1");
  assert.equal(t["langfuse.trace.input"], "You are Marta...", "the trace input defaults to what the model was sent");
  assert.deepEqual(JSON.parse(t["langfuse.trace.output"]), RUN.generations[0].output);
  assert.equal(t["langfuse.trace.metadata.agent_id"], "concierge");
  assert.equal(t["langfuse.trace.metadata.rules_hash"], concierge.rulesHash);
  assert.equal(t["langfuse.trace.metadata.stage"], concierge.stage);
  assert.equal(t["langfuse.trace.metadata.guard_action"], "escalate");
  assert.equal(t["langfuse.trace.metadata.escalate"], false);
  assert.ok(!("langfuse.trace.metadata.escalation_reason" in t), "null attributes are dropped");
  assert.ok(!("langfuse.observation.level" in t), "a clean run has no error level");

  const g = attrs(generation);
  assert.equal(g["langfuse.observation.type"], "generation");
  assert.equal(g["langfuse.observation.model.name"], "anthropic/claude-sonnet-5");
  assert.deepEqual(JSON.parse(g["langfuse.observation.usage_details"]), { input: 1200, output: 80, total: 1280 });
  assert.deepEqual(JSON.parse(g["langfuse.observation.cost_details"]), { total: 0.0048 });
});

test("a run with several calls gets one generation each, and a failed call marks the run as an error", () => {
  const run = {
    agent: agentSpec("hawkeye"),
    input: { photoKey: "orders/1/delivered.jpg" },
    output: { verdict: "review" },
    generations: [
      { ...RUN.generations[0], name: "claude" },
      {
        name: "gemini", model: "gemini-2.5-flash", input: "look", output: null, usage: { promptTokenCount: 300, candidatesTokenCount: 40 },
        error: "Gemini returned an empty response",
        startedAt: new Date("2026-10-13T10:00:01.000Z"), endedAt: new Date("2026-10-13T10:00:04.000Z"),
      },
    ],
  };
  const [root, claude, gemini] = spans(buildTracePayload(run, IDS, "s"));
  assert.equal(attrs(root)["langfuse.trace.name"], "Hawkeye");
  assert.deepEqual(JSON.parse(attrs(root)["langfuse.trace.input"]), run.input);
  assert.equal(root.endTimeUnixNano, "1791885604000000000", "the run spans its earliest start to its latest end");
  assert.equal(attrs(root)["langfuse.observation.level"], "ERROR");
  assert.equal(claude.spanId, IDS.generationSpanIds[0]);
  assert.equal(gemini.spanId, IDS.generationSpanIds[1]);
  assert.equal(attrs(gemini)["langfuse.observation.status_message"], "Gemini returned an empty response");
  assert.deepEqual(JSON.parse(attrs(gemini)["langfuse.observation.usage_details"]), { input: 300, output: 40 });
});

test("usage blocks from all three providers read as token counts", () => {
  assert.deepEqual(usageDetails({ prompt_tokens: 1, completion_tokens: 2 }), { input: 1, output: 2, total: undefined });
  assert.deepEqual(usageDetails({ input_tokens: 3, output_tokens: 4 }), { input: 3, output: 4, total: undefined });
  assert.deepEqual(usageDetails({ promptTokenCount: 5, candidatesTokenCount: 6, totalTokenCount: 11 }), { input: 5, output: 6, total: 11 });
  assert.equal(usageDetails({ foo: 1 }), null);
  assert.equal(usageDetails(null), null);
});

test("an oversized input is capped rather than sent whole", () => {
  const big = "x".repeat(MAX_ATTRIBUTE_CHARS + 50);
  assert.equal(asText(big).length, MAX_ATTRIBUTE_CHARS + "...[50 more chars]".length);
  assert.ok(asText(big).endsWith("...[50 more chars]"));
  assert.equal(asText("short"), "short");
});

test("the ingest worker's copy is this file, apart from the monitor import", () => {
  const dashboard = readFileSync(new URL("./langfuse.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const worker = readFileSync(new URL("../../ingest-worker/src/langfuse.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.equal(worker, dashboard.replace('from "./monitor.ts"', 'from "./monitor"'));
});
