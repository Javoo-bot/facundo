// OpenRouter transport — the one place this worker talks to an LLM.
//
// WHY NOT AN SDK. OpenRouter speaks the OpenAI-compatible /chat/completions
// shape, and this repo already calls it with plain fetch elsewhere (see
// dashboard/lib/photoVerify/openrouter.ts). Adding an SDK for one endpoint
// would be a bigger Workers-compat surface than the ~60 lines below.
//
// WHAT THE SDK USED TO DO FOR US. The Anthropic SDK was constructed with
// `{ timeout: 30_000, maxRetries: 2 }` (workflow.ts). `fetch` has NEITHER — no
// timeout at all and no retry. Dropping in a bare fetch would have swapped a
// bounded, self-healing call for one that can hang a Workflow step until the
// platform kills it, and that fails a whole city's ingest on one blip. So both
// are reimplemented here explicitly rather than left to the caller.
//
// FAILURE POLICY. Retry only what a retry can fix — 429 and 5xx and network
// errors. A 4xx is the request's own fault (bad key, exhausted credit, bad
// schema) and retrying it just burns the clock three times before failing
// identically; those throw on the first response so the caller sees the real
// message.

import type { ApiUsage } from "./usage";
import type { Env } from "./types";
import { WORKER_AGENTS, type WorkerAgentId } from "./agents.generated";
import { sendAgentRun, type MetadataValue } from "./langfuse";

/** Everything a call needs. Replaces the `Anthropic` client that used to be
 *  threaded through enrich/keywords/relevance. */
export interface LlmClient {
  apiKey: string;
  /** LANGFUSE_* from the Worker env; none set means no traces. */
  traceEnv?: Record<string, string | undefined>;
}

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
/** Matches the Anthropic SDK's old per-call timeout. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Matches the SDK's `maxRetries: 2` — three attempts total. */
export const MAX_RETRIES = 2;

/** OpenAI-shaped tool definition. */
export interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  max_tokens: number;
  messages: { role: "user"; content: string }[];
  tools?: ChatTool[];
  tool_choice?: { type: "function"; function: { name: string } };
}

export interface ChatResponse {
  choices?: { message?: { content?: string | null; tool_calls?: { function?: { name?: string; arguments?: string } }[] } }[];
  usage?: ApiUsage;
  error?: { message?: string; code?: number | string };
}

const RETRYABLE_STATUS = (s: number): boolean => s === 429 || s >= 500;

/** A status the caller can branch on — notably 402, which is what an exhausted
 *  account returns and which the run-level guard reports specially. */
export class OpenRouterError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = "OpenRouterError";
  }
}

/** Statuses that mean "every call after this one fails too": no credit, bad
 * key, key not permitted. Nothing about the florist we happened to be on. */
const OUTAGE_STATUS = new Set([401, 402, 403]);

/** Text fallback for the same condition arriving under a status that doesn't
 * say so. Anthropic returned the 2026-08-06 credit exhaustion as a plain 400
 * ("Your credit balance is too low to access the Anthropic API"), which a
 * status check alone would wave through as an ordinary bad request. Kept
 * deliberately short and lowercase; it is a safety net under the status check,
 * not the primary signal. */
const OUTAGE_TEXT = ["credit balance is too low", "insufficient credit", "quota exceeded"];

/**
 * Is this error the account being down rather than this one call going wrong?
 *
 * The distinction decides whether per-florist isolation is right or actively
 * harmful. A broken site, a timeout, a model returning nonsense — isolate those,
 * skip the florist, carry on. An exhausted or rejected key is not isolable: the
 * next florist fails identically, and the run's only achievement is to overwrite
 * a city's worth of rows with empty enrichments and a note about billing.
 *
 * That is not hypothetical. 1,065 florists still carry
 * "Please go to Plans & Billing to upgrade or purchase credits" in
 * `enrichment_notes`, each with a null email, from a run that kept going.
 */
export function isLlmOutage(e: unknown): boolean {
  if (!(e instanceof OpenRouterError)) return false;
  if (e.status !== null && OUTAGE_STATUS.has(e.status)) return true;
  const message = e.message.toLowerCase();
  return OUTAGE_TEXT.some((marker) => message.includes(marker));
}

export function llmClient(env: Env): LlmClient {
  return {
    apiKey: env.OPENROUTER_API_KEY,
    traceEnv: {
      LANGFUSE_PUBLIC_KEY: env.LANGFUSE_PUBLIC_KEY,
      LANGFUSE_SECRET_KEY: env.LANGFUSE_SECRET_KEY,
      LANGFUSE_BASE_URL: env.LANGFUSE_BASE_URL,
    },
  };
}

/** Which agent is calling, and what this call is within its run. */
export interface ChatTag {
  agent: WorkerAgentId;
  /** "ecommerce", "email", "relevance", ... */
  name: string;
  /** Groups calls in Langfuse: a place id, a country. */
  sessionId?: string | null;
  metadata?: Record<string, MetadataValue>;
}

/** One completion, traced. Every worker model call comes through here, so this
 * is the one place a Langfuse trace is sent from: one per call, success or
 * failure, awaited before returning because a Workflow step does not wait for
 * a fetch nobody awaits. With no LANGFUSE_* the send is a no-op. */
export async function chat(client: LlmClient, req: ChatRequest, tag: ChatTag): Promise<ChatResponse> {
  const startedAt = new Date();
  let res: ChatResponse | null = null;
  let error: string | null = null;
  try {
    res = await complete(client, req);
    return res;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    const message = res?.choices?.[0]?.message;
    const args = message?.tool_calls?.[0]?.function?.arguments;
    await sendAgentRun(
      {
        agent: WORKER_AGENTS[tag.agent],
        sessionId: tag.sessionId,
        metadata: tag.metadata,
        generations: [
          {
            name: tag.name,
            model: req.model,
            input: req.messages.length === 1 ? req.messages[0].content : req.messages,
            output: args ?? message?.content ?? null,
            usage: res?.usage ?? null,
            error,
            startedAt,
            endedAt: new Date(),
          },
        ],
      },
      { env: client.traceEnv ?? {}, service: "facundo-ingest-worker" }
    );
  }
}

/** POST one completion, with timeout + bounded retry. Always asks for usage
 *  accounting (`usage.include`) so cost lands on the response rather than
 *  being re-derived from a hand-maintained rate table. */
async function complete(client: LlmClient, req: ChatRequest): Promise<ChatResponse> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // 500ms, then 1500ms. Short enough to stay inside a Workflow step,
      // long enough to ride out a rate-limit burst.
      await new Promise((r) => setTimeout(r, 500 * Math.pow(3, attempt - 1)));
    }
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${client.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...req, usage: { include: true } }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new OpenRouterError(`OpenRouter ${res.status}: ${body.slice(0, 300)}`, res.status);
        if (!RETRYABLE_STATUS(res.status)) throw err; // 4xx — retrying changes nothing
        lastError = err;
        continue;
      }

      const json = (await res.json()) as ChatResponse;
      // OpenRouter can return a 200 whose body carries an error (upstream
      // provider failure). Treat it as a failed attempt, not as a response.
      if (json.error) {
        const status = typeof json.error.code === "number" ? json.error.code : null;
        const err = new OpenRouterError(`OpenRouter: ${json.error.message ?? "unknown error"}`, status);
        if (status !== null && !RETRYABLE_STATUS(status)) throw err;
        lastError = err;
        continue;
      }
      return json;
    } catch (e) {
      if (e instanceof OpenRouterError) throw e; // already classified as terminal
      // Timeout (AbortError) or network failure — both worth another attempt.
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastError ?? new OpenRouterError("OpenRouter: request failed", null);
}
