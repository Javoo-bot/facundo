// Agent run traces into Langfuse, over its OTLP HTTP/JSON endpoint.
//
// One trace per agent run: a root span named after the agent, carrying what it
// was shown and what it answered, and one generation under it per model call.
//
// Plain fetch, no SDK, and alias-free (relative imports only) so `node --test`
// can import it. The endpoint is /api/public/otel/v1/traces, not the older
// POST /api/public/ingestion: that one still answers 207 for this org, but its
// own response says it stops accepting traces on 2026-11-16.
//
// The same file is dashboard/lib/langfuse.ts and ingest-worker/src/langfuse.ts
// (the two builds share no code); only the monitor import differs, and
// dashboard/lib/langfuse.test.mjs fails if the copies drift apart.
//
// Env-gated. With any of LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY or
// LANGFUSE_BASE_URL unset this is a no-op, and production sets none of them:
// that absence is the switch that keeps production runs out of Langfuse.
//
// Never throws. A trace is a record of a run, never a reason for one to fail.

import { captureError } from "./monitor";

const DEFAULT_TIMEOUT_MS = 3_000;
const OTLP_PATH = "/api/public/otel/v1/traces";
/** Langfuse truncates big attributes on its side anyway; capping here keeps one
 * stats-chat round with 500 rows of SQL output from making a multi-MB request. */
export const MAX_ATTRIBUTE_CHARS = 100_000;

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

type Env = Record<string, string | undefined>;

export function langfuseConfig(env: Env): LangfuseConfig | null {
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  const baseUrl = env.LANGFUSE_BASE_URL;
  if (!publicKey || !secretKey || !baseUrl) return null;
  return { publicKey, secretKey, baseUrl: baseUrl.replace(/\/+$/, "") };
}

/** The agent, as agents/thinking/<id>.md describes it. */
export interface TraceAgent {
  id: string;
  nick: string;
  name: string;
  stage: string;
  rulesHash: string;
}

/** One model call. */
export interface Generation {
  /** What this call was within the run: "draft", "round-2", "email", "claude". */
  name: string;
  model: string;
  /** The prompt or message list sent, without image bytes. */
  input: unknown;
  /** The tool arguments or text the model returned; null when it failed. */
  output: unknown;
  /** The provider's usage block: OpenRouter, Anthropic or Gemini shape. */
  usage?: unknown;
  error?: string | null;
  startedAt: Date;
  endedAt: Date;
}

export type MetadataValue = string | number | boolean | null | undefined;

export interface AgentRun {
  agent: TraceAgent;
  /** Groups runs in Langfuse: a conversation, an order, a place. */
  sessionId?: string | null;
  /** What the agent was shown. Defaults to the first generation's input. */
  input?: unknown;
  /** What the run produced. Defaults to the last generation's output. */
  output?: unknown;
  metadata?: Record<string, MetadataValue>;
  generations: Generation[];
}

export interface TraceIds {
  traceId: string;
  rootSpanId: string;
  generationSpanIds: string[];
}

type AnyValue = { stringValue: string } | { boolValue: boolean } | { doubleValue: number };
type Attribute = { key: string; value: AnyValue };

function attr(key: string, value: MetadataValue): Attribute[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "boolean") return [{ key, value: { boolValue: value } }];
  if (typeof value === "number") return [{ key, value: { doubleValue: value } }];
  return [{ key, value: { stringValue: value } }];
}

export function asText(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return s.length > MAX_ATTRIBUTE_CHARS ? `${s.slice(0, MAX_ATTRIBUTE_CHARS)}...[${s.length - MAX_ATTRIBUTE_CHARS} more chars]` : s;
}

const nanos = (d: Date) => (BigInt(d.getTime()) * 1_000_000n).toString();

/** Token counts in Langfuse's usage_details shape, from an OpenRouter
 * (prompt_tokens), Anthropic (input_tokens) or Gemini (promptTokenCount) usage
 * block. Null when there is no usable count. */
export function usageDetails(usage: unknown): { input?: number; output?: number; total?: number } | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof u[k] === "number") return u[k] as number;
    return undefined;
  };
  const out = {
    input: pick("prompt_tokens", "input_tokens", "promptTokenCount"),
    output: pick("completion_tokens", "output_tokens", "candidatesTokenCount"),
    total: pick("total_tokens", "totalTokenCount"),
  };
  return out.input === undefined && out.output === undefined && out.total === undefined ? null : out;
}

/** OpenRouter's billed cost in USD, when the response carried one. */
export function usageCost(usage: unknown): number | null {
  const cost = usage && typeof usage === "object" ? (usage as { cost?: unknown }).cost : undefined;
  return typeof cost === "number" ? cost : null;
}

/** The OTLP/JSON body for one run: a root span named after the agent, with one
 * generation span per model call under it. */
export function buildTracePayload(run: AgentRun, ids: TraceIds, service: string) {
  const { agent, generations } = run;
  if (generations.length === 0) throw new Error("a trace needs at least one generation");
  const input = asText(run.input !== undefined ? run.input : generations[0].input);
  const output = asText(run.output !== undefined ? run.output : generations[generations.length - 1].output);
  const startedAt = new Date(Math.min(...generations.map((g) => g.startedAt.getTime())));
  const endedAt = new Date(Math.max(...generations.map((g) => g.endedAt.getTime())));
  const failed = generations.find((g) => g.error);
  const metadata: Record<string, MetadataValue> = {
    agent_id: agent.id,
    agent_name: agent.name,
    stage: agent.stage,
    rules_hash: agent.rulesHash,
    ...run.metadata,
  };

  const root = {
    traceId: ids.traceId,
    spanId: ids.rootSpanId,
    name: `${agent.id}.run`,
    kind: 1,
    startTimeUnixNano: nanos(startedAt),
    endTimeUnixNano: nanos(endedAt),
    attributes: [
      ...attr("langfuse.trace.name", agent.nick),
      ...attr("langfuse.session.id", run.sessionId),
      ...attr("langfuse.trace.input", input),
      ...attr("langfuse.trace.output", output),
      ...Object.entries(metadata).flatMap(([k, v]) => attr(`langfuse.trace.metadata.${k}`, v)),
      ...attr("langfuse.observation.input", input),
      ...attr("langfuse.observation.output", output),
      ...attr("langfuse.observation.level", failed ? "ERROR" : null),
      ...attr("langfuse.observation.status_message", failed?.error),
    ],
  };

  const spans = generations.map((g, i) => {
    const usage = usageDetails(g.usage);
    const cost = usageCost(g.usage);
    return {
      traceId: ids.traceId,
      spanId: ids.generationSpanIds[i],
      parentSpanId: ids.rootSpanId,
      name: `${agent.id}.${g.name}`,
      kind: 3,
      startTimeUnixNano: nanos(g.startedAt),
      endTimeUnixNano: nanos(g.endedAt),
      attributes: [
        ...attr("langfuse.session.id", run.sessionId),
        ...attr("langfuse.observation.type", "generation"),
        ...attr("langfuse.observation.model.name", g.model),
        ...attr("langfuse.observation.input", asText(g.input)),
        ...attr("langfuse.observation.output", asText(g.output)),
        ...attr("langfuse.observation.usage_details", usage ? JSON.stringify(usage) : null),
        ...attr("langfuse.observation.cost_details", cost !== null ? JSON.stringify({ total: cost }) : null),
        ...attr("langfuse.observation.level", g.error ? "ERROR" : null),
        ...attr("langfuse.observation.status_message", g.error),
      ],
    };
  });

  return {
    resourceSpans: [
      {
        resource: { attributes: [...attr("service.name", service)] },
        scopeSpans: [{ scope: { name: `facundo.${agent.id}` }, spans: [root, ...spans] }],
      },
    ],
  };
}

function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function newTraceIds(generations: number): TraceIds {
  return {
    traceId: randomHex(16),
    rootSpanId: randomHex(8),
    generationSpanIds: Array.from({ length: generations }, () => randomHex(8)),
  };
}

export interface SendOptions {
  /** Where LANGFUSE_* are read from: process.env in the dashboard, the Worker's
   * `env` binding in the ingest worker. */
  env: Env;
  /** Names the sending build in Langfuse. */
  service: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  ids?: TraceIds;
}

/** Send one agent run. Resolves to the trace id when Langfuse accepted it, or
 * null when disabled, when the run has no generations, or on any failure. */
export async function sendAgentRun(run: AgentRun, opts: SendOptions): Promise<string | null> {
  const config = langfuseConfig(opts.env);
  if (!config || run.generations.length === 0) return null;
  const { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  try {
    const ids = opts.ids ?? newTraceIds(run.generations.length);
    const res = await fetchImpl(`${config.baseUrl}${OTLP_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${config.publicKey}:${config.secretKey}`)}`,
        "Content-Type": "application/json",
        "x-langfuse-ingestion-version": "4",
      },
      body: JSON.stringify(buildTracePayload(run, ids, opts.service)),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      captureError(`langfuse.${run.agent.id}`, new Error(`Langfuse ${res.status}: ${detail.slice(0, 200)}`));
      return null;
    }
    return ids.traceId;
  } catch (e) {
    captureError(`langfuse.${run.agent.id}`, e);
    return null;
  }
}
