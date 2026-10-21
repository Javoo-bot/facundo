import { combineVerdicts } from "./combine";
import { verifyWithClaude } from "./claude";
import { verifyWithGemini } from "./gemini";
import { verifyWithOpenRouter, OPENROUTER_MODELS } from "./openrouter";
import type { Generation } from "../langfuse";
import type { ExpectedItem, OpenRouterJudgment, OpenRouterResult, OpenRouterResults, ProviderName, ProviderResult, VerificationResult } from "./types";

export type { ExpectedItem, VerificationResult, Verdict } from "./types";
export { combineVerdicts } from "./combine";

type Media = "image/jpeg" | "image/png" | "image/webp";

export interface ProviderToggles {
  claude?: boolean;
  gemini?: boolean;
  // Shadow-mode opinions (OpenRouter → gemini-2.5-pro + qwen3-vl-30b-a3b, see
  // OPENROUTER_MODELS in openrouter.ts). One toggle for both — simple on/off
  // for "the OpenRouter evaluation pass" rather than per-model granularity,
  // since neither ever participates in `verdict` — see types.ts's header
  // comment on OpenRouterResult.
  openrouter?: boolean;
}

export interface VerifyInput {
  photoBytes: ArrayBuffer | Uint8Array;
  mediaType: string;
  items: ExpectedItem[];
  providers?: ProviderToggles;
}

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Buffer.from(buf).toString("base64");
}

function normMedia(m: string): Media {
  if (m === "image/png") return "image/png";
  if (m === "image/webp") return "image/webp";
  return "image/jpeg";
}

// Wrap a provider call so a failure/absence never throws — it just becomes an
// `ok:false` result whose vote `combine.ts` ignores (and which holds the payout).
async function run(provider: ProviderName, fn: () => Promise<Omit<ProviderResult, "provider" | "ok" | "error">>): Promise<ProviderResult> {
  try {
    const j = await fn();
    return { provider, ok: true, ...j };
  } catch (e) {
    return {
      provider,
      ok: false,
      matched: false,
      confidence: 0,
      itemsFound: [],
      itemsMissing: [],
      notes: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function enabled(providers: ProviderToggles | undefined): { claude: boolean; gemini: boolean; openrouter: boolean } {
  return {
    claude: (providers?.claude ?? true) && !!process.env.OPENROUTER_API_KEY,
    gemini: (providers?.gemini ?? true) && !!process.env.GEMINI_API_KEY,
    openrouter: (providers?.openrouter ?? true) && !!process.env.OPENROUTER_API_KEY,
  };
}

// True when at least one CONSENSUS provider could actually run (toggled on + API
// key set). The photo route uses this to decide whether to attempt the
// payout-gating verification at all. Deliberately unchanged by the addition of
// OpenRouter above: that leg is shadow-mode and must never affect whether this
// returns true/false, so an OPENROUTER_API_KEY alone still does not "turn on"
// verification for existing callers/behavior.
export function verificationAvailable(providers?: ProviderToggles): boolean {
  const e = enabled(providers);
  return e.claude || e.gemini;
}

// True when the shadow-mode OpenRouter leg could actually run (toggled on + API
// key set). Independent of `verificationAvailable` above — callers can run the
// OpenRouter leg on its own even when Claude/Gemini are both off.
export function openRouterAvailable(providers?: ProviderToggles): boolean {
  return enabled(providers).openrouter;
}

async function runOpenRouter(model: string, fn: () => Promise<OpenRouterJudgment>): Promise<OpenRouterResult> {
  try {
    const j = await fn();
    return { model, ok: true, ...j };
  } catch (e) {
    return {
      model,
      ok: false,
      score: 0,
      matched: false,
      confidence: 0,
      itemsFound: [],
      itemsMissing: [],
      notes: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// Run every enabled provider in parallel and combine their judgments. Always
// resolves (never throws): if nothing ran, the verdict is `review` (hold).
// The OpenRouter legs (when enabled) run in the same parallel batch but their
// results are kept OUT of `combineVerdicts` — shadow-mode, evaluation only.
export async function verifyDeliveryPhoto(input: VerifyInput): Promise<VerificationResult> {
  const media = normMedia(input.mediaType);
  const base64 = toBase64(input.photoBytes);
  const e = enabled(input.providers);
  const calls: Generation[] = [];

  const tasks: Promise<ProviderResult>[] = [];
  if (e.claude) tasks.push(run("claude", () => verifyWithClaude(base64, media, input.items, calls)));
  if (e.gemini) tasks.push(run("gemini", () => verifyWithGemini(base64, media, input.items, calls)));

  const openrouterGeminiTask: Promise<OpenRouterResult | undefined> = e.openrouter
    ? runOpenRouter(OPENROUTER_MODELS.gemini, () => verifyWithOpenRouter(base64, media, input.items, OPENROUTER_MODELS.gemini, calls))
    : Promise.resolve(undefined);
  const openrouterQwenTask: Promise<OpenRouterResult | undefined> = e.openrouter
    ? runOpenRouter(OPENROUTER_MODELS.qwen, () => verifyWithOpenRouter(base64, media, input.items, OPENROUTER_MODELS.qwen, calls))
    : Promise.resolve(undefined);

  const [results, gemini, qwen] = await Promise.all([Promise.all(tasks), openrouterGeminiTask, openrouterQwenTask]);
  const combined = { ...combineVerdicts(results), calls };
  const openrouter: OpenRouterResults | undefined = gemini || qwen ? { gemini, qwen } : undefined;
  return openrouter ? { ...combined, openrouter } : combined;
}
