import { OpenRouterJudgmentSchema, describeItems, recordCall, type ExpectedItem, type OpenRouterJudgment } from "./types";
import type { Generation } from "../langfuse";

// OpenRouter SHADOW-MODE opinions — two models, both routed through the same
// OpenRouter integration (one API key, one code path) rather than three
// separate provider SDKs. Unlike Claude/Gemini above, these legs also look at
// the ordered product's own reference photo(s) — fetched from Shopify's CDN,
// best-effort — not just the text spec, and report a 0-100 `score` alongside
// the same judgment shape. Recorded for evaluation only: must never reach
// combine.ts / payout (see the header comment on OpenRouterJudgmentSchema in
// ./types.ts for why).
//
// Model picks (2026-07-26 value-for-money check against OpenRouter's live
// pricing/capability API): `gemini-2.5-pro` was the user's original pick;
// `qwen3-vl-30b-a3b-instruct` was added as a cheap, genuinely independent
// second opinion (different lineage from both Claude and Gemini, purpose-built
// for general visual reasoning — Kimi K2.5 was considered but is priced ~4-5x
// higher while being tuned for visual coding/UI reading, not photo comparison).
export const OPENROUTER_MODELS = {
  gemini: "google/gemini-2.5-pro",
  qwen: "qwen/qwen3-vl-30b-a3b-instruct",
} as const;
export type OpenRouterModelKey = keyof typeof OPENROUTER_MODELS;

// No OpenRouter SDK in this repo's deps — plain fetch() against their
// OpenAI-compatible /chat/completions endpoint, using forced tool-calling
// (mirrors claude.ts's forced tool_use pattern, adapted to the OpenAI shape).

const MAX_REFERENCE_IMAGES = 4; // bound cost/latency on multi-item orders
const REFERENCE_FETCH_TIMEOUT_MS = 8000;
// This is a shadow-mode leg that must never stall the real delivered-photo/payout
// request it rides alongside (see index.ts's Promise.all) — bound it explicitly
// rather than trusting OpenRouter (or the network) to hang up in reasonable time.
const REQUEST_TIMEOUT_MS = 20000;

const TOOL = {
  type: "function" as const,
  function: {
    name: "report_photo_score",
    description:
      "Report a numeric match score for the florist's delivery photo against the ordered product, judged against both its text spec and its reference photo(s).",
    parameters: {
      type: "object",
      properties: {
        score: {
          type: "number",
          description:
            "0-100: how well the delivered photo matches the ordered arrangement — 0 is clearly wrong/no match, 100 is a confident, complete match.",
        },
        matched: { type: "boolean", description: "True only if the photo plausibly shows the ordered arrangement (right flowers / products)." },
        confidence: { type: "number", description: "Your confidence in the `matched` call, 0 to 1." },
        itemsFound: { type: "array", items: { type: "string" }, description: "Ordered items you can see in the photo." },
        itemsMissing: { type: "array", items: { type: "string" }, description: "Ordered items you canNOT see in the photo." },
        notes: { type: "string", description: "One or two sentences a human reviewer can read." },
      },
      required: ["score", "matched", "confidence", "itemsFound", "itemsMissing", "notes"],
    },
  },
};

function prompt(items: ExpectedItem[], referenceCount: number): string {
  return [
    "You are scoring a florist's delivery-proof photo before releasing their final payment.",
    "The customer ordered:",
    describeItems(items),
    "",
    referenceCount > 0
      ? `You are also attached ${referenceCount} reference photo(s) of the ordered product(s) as sold, each labelled right before it, followed LAST by the florist's delivered photo (also labelled). Visually compare the delivered photo against the reference photo(s) AND the text spec above — do not judge on text alone.`
      : "No reference photo of the ordered product was available (Shopify had none, or the fetch failed) — judge against the text spec and the delivered photo only.",
    "Be conservative: if the delivered photo is blurry, generic, clearly a stock/reused image, only shows some of the items, or looks meaningfully different from the reference photo(s), reflect that in a LOW score/confidence and list what is missing.",
    "Report your finding via the report_photo_score tool only.",
  ].join("\n");
}

async function fetchReferenceImage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REFERENCE_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return null;
    const buf = await res.arrayBuffer();
    return `data:${contentType};base64,${Buffer.from(buf).toString("base64")}`;
  } catch {
    return null; // best-effort — a reference-photo lookup failure is not fatal
  }
}

export async function verifyWithOpenRouter(
  deliveredBase64: string,
  deliveredMediaType: "image/jpeg" | "image/png" | "image/webp",
  items: ExpectedItem[],
  model: string,
  calls: Generation[],
): Promise<OpenRouterJudgment> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");

  // Best-effort: fetch up to MAX_REFERENCE_IMAGES distinct product reference photos.
  const urls = [...new Set(items.map((i) => i.imageUrl).filter((u): u is string => !!u))].slice(0, MAX_REFERENCE_IMAGES);
  const references = (await Promise.all(urls.map(fetchReferenceImage))).filter((r): r is string => r !== null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenAI-compatible content-part union, no shared SDK types here
  const content: any[] = [{ type: "text", text: prompt(items, references.length) }];
  references.forEach((dataUri, i) => {
    content.push({ type: "text", text: `Reference photo ${i + 1} of the ordered product:` });
    content.push({ type: "image_url", image_url: { url: dataUri } });
  });
  content.push({ type: "text", text: "The florist's delivered photo:" });
  content.push({ type: "image_url", image_url: { url: `data:${deliveredMediaType};base64,${deliveredBase64}` } });

  const shown = content.map((part) => (part.type === "image_url" ? "[image]" : part.text));
  const name = model === OPENROUTER_MODELS.qwen ? "shadow-qwen" : "shadow-gemini";
  return recordCall(calls, { name, model, input: shown }, async (note) => {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        tools: [TOOL],
        tool_choice: { type: "function", function: { name: TOOL.function.name } },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 500)}`);
    }

    const json = (await res.json()) as {
      choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[];
      usage?: unknown;
    };
    const args = json.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    note(args ?? null, json.usage ?? null);
    if (!args) throw new Error("OpenRouter returned no tool call");
    return OpenRouterJudgmentSchema.parse(JSON.parse(args));
  });
}
