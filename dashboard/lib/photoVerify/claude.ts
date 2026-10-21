import Anthropic from "@anthropic-ai/sdk";
import { ProviderJudgmentSchema, describeItems, recordCall, type ExpectedItem, type ProviderJudgment } from "./types";
import type { Generation } from "../langfuse";

// Claude vision leg of the verification gate. Uses forced tool-use so the model
// returns a structured judgment (the most reliable structured-output path on the
// current SDK) which we then validate with zod.

// OpenRouter slug. Every LLM call in this product goes through OpenRouter —
// one key, one bill, one place to swap a model. OpenRouter exposes an
// ANTHROPIC-COMPATIBLE endpoint at /api/v1/messages (native content blocks,
// tool_use, vision and usage), so the SDK below is unchanged apart from its
// baseURL: this is a routing change, not a rewrite of the call.
const MODEL = "anthropic/claude-sonnet-5"; // vision-capable; per repo convention (CLAUDE.md)
// NOTE the base: the Anthropic SDK appends "/v1/messages" itself, so this is
// ".../api" and NOT ".../api/v1" — the latter produces /api/v1/v1/messages,
// which OpenRouter answers with an HTML page rather than an API error.
const OPENROUTER_BASE = "https://openrouter.ai/api";

const TOOL = {
  name: "report_photo_verification",
  description: "Report whether the florist's delivery photo shows the ordered flower arrangement and add-ons.",
  input_schema: {
    type: "object" as const,
    properties: {
      matched: { type: "boolean", description: "True only if the photo plausibly shows the ordered arrangement (right flowers / products)." },
      confidence: { type: "number", description: "Your confidence in the `matched` call, 0 to 1." },
      itemsFound: { type: "array", items: { type: "string" }, description: "Ordered items you can see in the photo." },
      itemsMissing: { type: "array", items: { type: "string" }, description: "Ordered items you canNOT see in the photo." },
      notes: { type: "string", description: "One or two sentences a human reviewer can read." },
    },
    required: ["matched", "confidence", "itemsFound", "itemsMissing", "notes"],
  },
};

function prompt(items: ExpectedItem[]): string {
  return [
    "You are verifying a florist's delivery-proof photo before releasing their final payment.",
    "The customer ordered:",
    describeItems(items),
    "",
    "Look at the attached photo. Decide whether it genuinely shows THIS order — the right kind of flowers/arrangement and any add-ons (chocolate, wine, vase, card).",
    "Be conservative: if the photo is blurry, generic, clearly a stock/reused image, or only shows some of the items, reflect that in a LOW confidence and list what is missing.",
    "Report via the report_photo_verification tool only.",
  ].join("\n");
}

export async function verifyWithClaude(
  base64: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
  items: ExpectedItem[],
  calls: Generation[],
): Promise<ProviderJudgment> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const anthropic = new Anthropic({ apiKey, baseURL: OPENROUTER_BASE });
  const text = prompt(items);

  return recordCall(calls, { name: "claude", model: MODEL, input: ["[the delivery photo]", text] }, async (note) => {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text },
          ],
        },
      ],
    });

    const block = msg.content.find((b) => b.type === "tool_use");
    note(block?.type === "tool_use" ? block.input : msg.content, msg.usage);
    if (!block || block.type !== "tool_use") throw new Error("Claude returned no tool_use block");
    return ProviderJudgmentSchema.parse(block.input);
  });
}
