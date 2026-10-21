import { z } from "zod";
import type { Generation } from "../langfuse.ts";

// Shared shapes for the dual-provider delivery-photo verification gate.
// Each provider (Claude, Gemini) looks at the florist's proof photo next to the
// ordered line items and returns this judgment; `combine.ts` folds the judgments
// into a single verdict that drives the payout hold.

export type ProviderName = "claude" | "gemini";
export type Verdict = "pass" | "review" | "fail";

// The structured judgment we force each vision model to return.
export const ProviderJudgmentSchema = z.object({
  // Does the photo plausibly show the ordered arrangement (right flowers/products)?
  matched: z.boolean(),
  // The model's own confidence in that call, 0..1.
  confidence: z.number().min(0).max(1),
  // Ordered items the model can see in the photo (free-text labels it chooses).
  itemsFound: z.array(z.string()).default([]),
  // Ordered items the model CANNOT see — drives partial-delivery holds.
  itemsMissing: z.array(z.string()).default([]),
  // One or two sentences a human can read in the CX queue.
  notes: z.string().default(""),
});
export type ProviderJudgment = z.infer<typeof ProviderJudgmentSchema>;

// A judgment plus which provider produced it and whether the call succeeded.
export interface ProviderResult extends ProviderJudgment {
  provider: ProviderName;
  ok: boolean; // false = the call errored / was skipped; its vote is ignored
  error?: string;
}

// SHADOW-MODE opinions, both routed through OpenRouter (see openrouter.ts for
// the two model picks). They also see the ordered product's reference
// photo(s), not just text, and report a 0-100 score. Intentionally NOT a
// `ProviderName` and never reaches `combineVerdicts` — recorded for evaluation
// only and must not affect `verdict`/payout gating. See lib/photoVerify/openrouter.ts.
export const OpenRouterJudgmentSchema = ProviderJudgmentSchema.extend({
  // Headline number the user asked for, distinct from `confidence` (0..1 above).
  score: z.number().min(0).max(100),
});
export type OpenRouterJudgment = z.infer<typeof OpenRouterJudgmentSchema>;

// A judgment plus which OpenRouter model produced it and whether the call
// succeeded — mirrors ProviderResult, but kept structurally separate so it can
// never be passed to combineVerdicts by mistake.
export interface OpenRouterResult extends OpenRouterJudgment {
  model: string; // OpenRouter model id, e.g. "google/gemini-2.5-pro"
  ok: boolean; // false = the call errored / was skipped
  error?: string;
}

// One shadow-mode result per OpenRouter model in play (see OPENROUTER_MODELS
// in openrouter.ts). Each key is `undefined` when that leg didn't run
// (disabled/no key), present when it ran (ok true or false).
export interface OpenRouterResults {
  gemini?: OpenRouterResult;
  qwen?: OpenRouterResult;
}

// The combined outcome persisted to `photo_verifications` and fed to payout.
export interface VerificationResult {
  verdict: Verdict;
  confidence: number; // mean of the successful providers' confidence
  providers: ProviderResult[];
  reasoning: string;
  // Shadow-mode opinions — evaluation only, never folded into `verdict`.
  openrouter?: OpenRouterResults;
  /** Every model call this check made, voters and shadows, image bytes left
   * out. What Hawkeye was shown, for photo_verifications.ai_context and the
   * Langfuse trace. */
  calls: Generation[];
}

/** Runs one provider call and appends what it was sent and what came back to
 * `calls`, whether it succeeded or threw. `note` hands over the raw model
 * output and usage once there is a response. */
export async function recordCall<T>(
  calls: Generation[],
  meta: Pick<Generation, "name" | "model" | "input">,
  fn: (note: (output: unknown, usage: unknown) => void) => Promise<T>,
): Promise<T> {
  const startedAt = new Date();
  let output: unknown = null;
  let usage: unknown = null;
  let error: string | null = null;
  try {
    return await fn((o, u) => {
      output = o;
      usage = u;
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    calls.push({ ...meta, output, usage, error, startedAt, endedAt: new Date() });
  }
}

// The ordered line item a photo is checked against (subset of order_line_items).
export interface ExpectedItem {
  title: string | null;
  variant: string | null;
  productType: string | null;
  spec: string | null; // bouquet_spec, e.g. "Pink roses x8, Eucalyptus x6"
  quantity: number;
  imageUrl: string | null; // Shopify product/variant reference photo, when available
}

// Human-readable description of the order used in the vision prompt.
export function describeItems(items: ExpectedItem[]): string {
  if (items.length === 0) return "(no itemised contents recorded for this order)";
  return items
    .map((it) => {
      const qty = it.quantity > 1 ? `${it.quantity}× ` : "";
      const variant = it.variant ? ` (${it.variant})` : "";
      const type = it.productType ? ` [${it.productType}]` : "";
      const spec = it.spec ? ` — ${it.spec}` : "";
      return `- ${qty}${it.title ?? "item"}${variant}${type}${spec}`;
    })
    .join("\n");
}
