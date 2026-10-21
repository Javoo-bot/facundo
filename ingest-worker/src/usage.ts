// Per-run LLM cost tracking. Port of ingest/usage.py::UsageTracker.
//
// Two things changed with the move to OpenRouter, both contained here so the
// rest of the worker (and `ingest_jobs.llm_cost_by_type`, and the /jobs page
// that reads it) sees the same shape as before:
//
//   1. Token field names are OpenAI's (`prompt_tokens` / `completion_tokens`),
//      not Anthropic's (`input_tokens` / `output_tokens`). The bucket keys keep
//      the old names so the stored JSONB is unchanged.
//   2. Cost is now REPORTED rather than derived. Every request asks for usage
//      accounting, so OpenRouter returns what it actually charged. PRICING
//      stays as a fallback for a response that omits it — a run must never
//      silently report $0 the way the pre-migration runs did.
import { PRICING, type CallType } from "./config";

export interface ApiUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  /** Actual USD charged, present when the request asked for usage accounting. */
  cost?: number | null;
}

interface Bucket {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  model: string;
  /** Summed reported cost. `null` until a response actually carries one, which
   *  is what distinguishes "free" from "not reported" when falling back. */
  reported_cost: number | null;
}

export class UsageTracker {
  private buckets: Map<string, Bucket> = new Map();

  /** Add one real API call's usage to `callType`'s bucket. Tolerant of a
   * missing/null usage payload (counts the call, adds 0 tokens). */
  record(callType: CallType | string, model: string, usage: ApiUsage | null | undefined): void {
    let b = this.buckets.get(callType);
    if (!b) {
      b = { calls: 0, input_tokens: 0, output_tokens: 0, model, reported_cost: null };
      this.buckets.set(callType, b);
    }
    b.calls += 1;
    b.model = model;
    b.input_tokens += usage?.prompt_tokens ?? 0;
    b.output_tokens += usage?.completion_tokens ?? 0;
    if (typeof usage?.cost === "number" && Number.isFinite(usage.cost)) {
      b.reported_cost = (b.reported_cost ?? 0) + usage.cost;
    }
  }

  private bucketCost(b: Bucket): number {
    // Prefer what OpenRouter says it charged — it stays correct across model
    // and price changes, which the hand-maintained table below does not.
    if (b.reported_cost !== null) return b.reported_cost;
    const rate = PRICING[b.model];
    if (!rate) {
      console.warn(`[usage] no pricing for model ${JSON.stringify(b.model)}; counting $0.`);
      return 0;
    }
    const [inRate, outRate] = rate;
    return (b.input_tokens / 1e6) * inRate + (b.output_tokens / 1e6) * outRate;
  }

  get costUsd(): number {
    let total = 0;
    for (const b of this.buckets.values()) total += this.bucketCost(b);
    return total;
  }

  get totalInputTokens(): number {
    let t = 0;
    for (const b of this.buckets.values()) t += b.input_tokens;
    return t;
  }

  get totalOutputTokens(): number {
    let t = 0;
    for (const b of this.buckets.values()) t += b.output_tokens;
    return t;
  }

  get totalCalls(): number {
    let t = 0;
    for (const b of this.buckets.values()) t += b.calls;
    return t;
  }

  /** JSONB payload for ingest_jobs.llm_cost_by_type. Omits types that never ran. */
  toByTypeDict(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [ct, b] of this.buckets) {
      out[ct] = {
        calls: b.calls,
        input_tokens: b.input_tokens,
        output_tokens: b.output_tokens,
        cost_usd: Math.round(this.bucketCost(b) * 1e6) / 1e6,
        model: b.model,
      };
    }
    return out;
  }
}
