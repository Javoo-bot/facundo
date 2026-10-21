// Personalisation leg for the recruiting email, via OpenRouter.
//
// The email's CONTENT is not the model's to invent — it comes from the catalog
// (lib/recruitingContent.ts) and is handed over verbatim as the approved text.
// What the model adds is the part a fixed template cannot: the florist's own
// language (there are far more languages than our six locales), the owner's
// name, and an opening built from what we actually researched about that shop.
//
// Routed through OpenRouter rather than a provider SDK, matching
// lib/photoVerify/openrouter.ts: one key, one code path, and the model is a
// config value rather than a code change. No OpenRouter SDK in this repo's
// deps, so this is plain fetch() against their OpenAI-compatible endpoint.
//
// This leg is ALWAYS optional. Every failure path returns null and the caller
// sends the deterministic catalog render instead — a missing key, a timeout, a
// non-200, a malformed body, or a reply that lost the "Subject:" contract. An
// outreach run must never fail because a model was unavailable.

import { traceAgentRun, type DashboardRun } from "./agentTrace.ts";

/** Overridable so a model swap is an env change, not a deploy. Sonnet is the
 * default because this is prose written to a stranger in an arbitrary
 * language, which is exactly where the cheap models get stilted. */
export const DEFAULT_RECRUITING_MODEL = "anthropic/claude-sonnet-5";

// Bounded explicitly: this runs inside a batch draft request (up to 25
// florists, 5 concurrent), so a hanging call would stall the whole run.
const REQUEST_TIMEOUT_MS = 30_000;

export interface PersonaliseArgs {
  prompt: string;
  apiKey: string;
  model?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** The recruiting draft must start with "Subject:" or the outreach panel
   * can't parse it. Other callers (the message translator) want the raw reply,
   * so they turn the check off rather than reimplement the whole caller. */
  requireSubjectLine?: boolean;
  timeoutMs?: number;
  /** Which agent is calling. Quill, Babel and Polyglot all ride this caller,
   * so each names itself for its Langfuse trace. */
  trace: Omit<DashboardRun, "generations">;
}

/** Returns the personalised draft, or null when this leg couldn't produce one.
 * Never throws and never rejects. */
export async function personaliseRecruitingEmail(args: PersonaliseArgs): Promise<string | null> {
  const {
    prompt, apiKey, model = DEFAULT_RECRUITING_MODEL, fetchImpl = fetch,
    timeoutMs = REQUEST_TIMEOUT_MS, requireSubjectLine = true,
  } = args;
  if (!apiKey || !prompt) return null;

  const startedAt = new Date();
  const out = await complete();
  await traceAgentRun({
    ...args.trace,
    generations: [
      { name: "write", model, input: prompt, output: out.text, usage: out.usage, error: out.error, startedAt, endedAt: new Date() },
    ],
  }, fetchImpl);
  if (out.error || !out.text) return null;
  // The outreach panel parses "Subject: ..." off the front
  // (lib/outreach.ts::parseDraft). A reply that dropped that contract would
  // silently produce an email with no subject, so we reject it and fall back
  // rather than send something malformed.
  if (requireSubjectLine && !/^\s*Subject:/i.test(out.text)) return null;
  return stripEmDashes(out.text.trim());

  async function complete(): Promise<{ text: string | null; usage: unknown; error: string | null }> {
    try {
      const res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 1600,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { text: null, usage: null, error: `OpenRouter ${res.status}` };
      const json: unknown = await res.json();
      return { text: extractText(json), usage: (json as { usage?: unknown })?.usage ?? null, error: null };
    } catch (e) {
      // timeout, network, malformed JSON — the caller falls back
      return { text: null, usage: null, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** Backstop for the no-em-dash rule. The prompt forbids them explicitly, but a
 * prompt is a request, not a guarantee — a real call reintroduced five of them
 * on the first live run, so this is not hypothetical. Every catalog string was
 * cleaned of em dashes; model-written prose is outbound copy too and gets held
 * to the same rule.
 *
 * A spaced em dash becomes a colon rather than a comma on purpose: the dash is
 * almost always joining an independent clause or introducing an elaboration,
 * and a comma there produces a splice ("click Accept, you get the address").
 * A colon is grammatical in both readings. Unspaced survivors become hyphens. */
export function stripEmDashes(text: string): string {
  return text.replace(/\s+—\s+/g, ": ").replace(/—/g, "-");
}

/** Pull the assistant text out of an OpenAI-compatible response, tolerating
 * both the plain string form and the content-parts array some models return. */
function extractText(json: unknown): string | null {
  const choice = (json as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") return content.trim() || null;
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === "string" ? part : ((part as { text?: unknown })?.text ?? "")))
      .filter((s): s is string => typeof s === "string")
      .join("")
      .trim();
    return joined || null;
  }
  return null;
}
