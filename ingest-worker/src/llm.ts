// Structured-output helper over OpenRouter.
//
// Same contract as before — force exactly one tool whose parameter schema IS
// the target shape, then read it back — but expressed in the OpenAI-compatible
// shape OpenRouter speaks rather than Anthropic's.
//
// THE ONE TRAP WORTH NAMING. Anthropic returned `tool_use.input` already
// parsed. OpenAI-shaped APIs return `tool_calls[0].function.arguments` as a
// **JSON string**. Handing that straight back as `T` type-checks fine and then
// fails much later as `undefined` field reads, so it is parsed here, and a
// model that emits malformed JSON throws with its raw output attached rather
// than returning a hollow object.
import { chat, type ChatTag, type ChatTool, type LlmClient } from "./openrouter";
import type { ApiUsage } from "./usage";

/** A tool-shaped description of the value we want back. `parameters` is plain
 *  JSON Schema — no SDK types, so the schema constants below stay portable. */
export interface StructuredSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

function toTool(schema: StructuredSchema): ChatTool {
  return { type: "function", function: { name: schema.name, description: schema.description, parameters: schema.parameters } };
}

export async function structured<T>(
  client: LlmClient,
  model: string,
  prompt: string,
  schema: StructuredSchema,
  maxTokens: number,
  tag: ChatTag
): Promise<{ parsed: T; usage: ApiUsage }> {
  const res = await chat(
    client,
    {
      model,
      max_tokens: maxTokens,
      tools: [toTool(schema)],
      tool_choice: { type: "function", function: { name: schema.name } },
      messages: [{ role: "user", content: prompt }],
    },
    tag
  );

  const args = res.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (typeof args !== "string") throw new Error(`${schema.name}: model returned no tool call`);
  let parsed: T;
  try {
    parsed = JSON.parse(args) as T;
  } catch {
    throw new Error(`${schema.name}: tool arguments were not valid JSON: ${args.slice(0, 200)}`);
  }
  return { parsed, usage: res.usage ?? {} };
}

export async function freeText(
  client: LlmClient,
  model: string,
  prompt: string,
  maxTokens: number,
  tag: ChatTag
): Promise<{ text: string; usage: ApiUsage }> {
  const res = await chat(client, { model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }, tag);
  return { text: (res.choices?.[0]?.message?.content ?? "").trim(), usage: res.usage ?? {} };
}

// --- JSON schemas for the prompts.py Pydantic models (unchanged shapes) ---
const num = { type: "number" as const };
const str = { type: "string" as const };
const strNull = { type: ["string", "null"] as ("string" | "null")[] };
const bool = { type: "boolean" as const };

export const ECOMMERCE_SCHEMA: StructuredSchema = {
  name: "classify_ecommerce",
  description: "Return whether the florist site supports online ordering.",
  parameters: {
    type: "object",
    properties: { is_ecommerce: bool, confidence: num, reasoning: str },
    required: ["is_ecommerce", "confidence", "reasoning"],
  },
};

export const EMAIL_SCHEMA: StructuredSchema = {
  name: "select_email",
  description: "Select the primary business email, or null.",
  parameters: {
    type: "object",
    properties: { email: strNull, confidence: num },
    required: ["email", "confidence"],
  },
};

export const PHONE_SCHEMA: StructuredSchema = {
  name: "select_phone",
  description: "Select the primary business phone, or null.",
  parameters: {
    type: "object",
    properties: { phone: strNull, confidence: num },
    required: ["phone", "confidence"],
  },
};

export const OWNER_SCHEMA: StructuredSchema = {
  name: "owner_info",
  description: "Extract owner name, shop highlight, and content language (nulls allowed).",
  parameters: {
    type: "object",
    properties: { owner_name: strNull, shop_highlight: strNull, content_language: strNull },
    required: ["owner_name", "shop_highlight", "content_language"],
  },
};

export const RELEVANCE_SCHEMA: StructuredSchema = {
  name: "classify_relevance",
  description: "Judge whether this Google Maps place is actually a florist.",
  parameters: {
    type: "object",
    properties: { is_florist: bool, confidence: num, reasoning: str },
    required: ["is_florist", "confidence", "reasoning"],
  },
};

export const KEYWORDS_SCHEMA: StructuredSchema = {
  name: "keyword_suggestion",
  description: "Localized florist search terms + Google Maps language code.",
  parameters: {
    type: "object",
    properties: { keywords: { type: "array", items: str }, language: str },
    required: ["keywords", "language"],
  },
};
