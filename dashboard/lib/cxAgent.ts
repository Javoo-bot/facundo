// The AI CX persona: reads a florist's reply and writes the next one in the
// persona's voice.
//
// Routed through OpenRouter, matching lib/recruitingPersonalise.ts and
// lib/photoVerify/openrouter.ts: one key, one code path, and the model is a
// config value (app_settings.cx_agent_model) rather than a code change. Plain
// fetch() against their OpenAI-compatible endpoint — there is no OpenRouter SDK
// in this repo's deps.
//
// Alias-free (relative imports only) so plain `node --test` can reach it, the
// same constraint lib/recruitingContent.ts and lib/offerSmsContent.ts carry.
//
// ONE DELIBERATE DIFFERENCE from recruitingPersonalise: that leg is optional
// and returns null on every failure, because the caller falls back to the
// deterministic catalog render. This one THROWS. There is no safe fallback for
// "we could not think of a reply" — the caller must escalate to a human, and a
// null that read as "nothing to say" could be mistaken for silence.
//
// WHAT THIS FILE DOES NOT DECIDE: whether the reply is sent. That is
// lib/cxAgentGuard.ts::escalationDecision, deliberately separate and
// deterministic, so the model's opinion of itself is an input rather than the
// verdict.
//
// The model does NOT invent the offer. It receives the approved pitch rendered
// verbatim from the catalog plus an explicit list of what it may assert — the
// same trick lib/draftEmail.ts uses. Editing /messages therefore changes what
// the agent is allowed to say, with no deploy.

import { z } from "zod";
import { stripEmDashes } from "./recruitingPersonalise.ts";
import type { AgentJudgment, AnyIntent } from "./cxAgentGuard.ts";
import { agentSpec } from "./agents/registry.generated.ts";

/** OpenRouter slug. Sonnet because this is prose to a stranger in an arbitrary
 * language, which is where cheap models get stilted — the same reasoning as
 * DEFAULT_RECRUITING_MODEL. */
export const DEFAULT_CX_AGENT_MODEL = "anthropic/claude-sonnet-5";

// Bounded: this runs inside a webhook whose job is to acknowledge the provider.
const REQUEST_TIMEOUT_MS = 30_000;

export type AgentKind = "recruiting" | "support";

const INTENTS = [
  "interested", "question_logistics", "question_pricing", "question_legal",
  "complaint", "opt_out", "wants_human", "asked_if_ai", "not_now", "unclear",
] as const;

/** The joined-florist taxonomy. Mirrors SupportIntent in cxAgentGuard.ts —
 * these two lists must stay in step, which is what the test at the bottom of
 * cxAgent.test.mjs asserts. */
export const SUPPORT_INTENTS = [
  "order_status", "payout_status", "photo_help", "process_explain", "app_howto",
  "delivery_problem", "change_request", "question_terms", "complaint", "opt_out",
  "wants_human", "asked_if_ai", "unclear",
] as const;

const INTENT_GUIDANCE: Record<AgentKind, string> = {
  recruiting:
    "What the florist wants. Use question_pricing when they ask about money, fees, commission or payment terms beyond the 70/30 split already in the approved pitch — a different percentage, a fee, invoicing, or anything the approved facts don't already cover. Restating or confirming the 70/30 split itself, from the approved pitch and facts, is not question_pricing. Use question_legal for contracts, invoicing, tax or data. Use wants_human if they ask to be put through to a person. Use asked_if_ai if they ask whether you ARE a person, a bot, or automated.",
  support:
    "What the florist wants. Use order_status for where/when questions about the order itself. Use payout_status for what we have already paid them and when. Use photo_help for how to send the delivery photo. Use process_explain for a general question about how the order process/lifecycle works or what happens next, grounded in the order facts, not a change. Use app_howto for how to use the app (accepting, installing, the recipe, teammates, language) and for a general, published Facundo policy question that is the same for every florist — getting paid, the Facundo card, whether the payout method can change, or the flower-substitution rule. Use delivery_problem if anything is WRONG with the order — wrong address, a flower they cannot get, nobody home — including a live decision on THIS real order (for example 'can I substitute this rose right now'), even when the general rule would allow it. Use change_request if they want us to actually change the date, the price, who is doing it, or their payout method for THIS payout. Use question_terms for commission, contracts, invoicing, tax or data. Use wants_human if they ask for a person. Use asked_if_ai if they ask whether you ARE a person, a bot, or automated. Use unclear if you are not sure which of these it is.",
};

const JudgmentSchema = z.object({
  intent: z.enum([...INTENTS, ...SUPPORT_INTENTS]),
  reply_text: z.string(),
  language: z.string().optional(),
  confidence: z.number(),
  escalate: z.boolean(),
  escalation_reason: z.string().nullable().optional(),
  facts_asserted: z.array(z.string()).default([]),
});

// OpenAI-compatible function-calling shape (not Anthropic's `input_schema`).
// Built per kind so the model is offered ONLY the taxonomy that applies —
// a support thread that could return `question_pricing` would land on a code
// path whose escalation list does not mention it.
const buildTool = (kind: AgentKind) => ({
  type: "function" as const,
  function: {
    name: "draft_persona_reply",
    description: "Classify the florist's message and draft the reply to send them.",
    parameters: {
      type: "object" as const,
      properties: {
        intent: {
          type: "string",
          enum: kind === "support" ? SUPPORT_INTENTS : INTENTS,
          description: INTENT_GUIDANCE[kind],
        },
        reply_text: {
          type: "string",
          description: "The reply to send, as plain text, in the florist's own language. No greeting line and no sign-off — those are added for you.",
        },
        language: { type: "string", description: "BCP-47 tag of the language the florist wrote in." },
        confidence: {
          type: "number",
          description: "How sure you are that this reply is correct AND safe to send without a human reading it first, 0 to 1.",
        },
        escalate: { type: "boolean", description: "True if a human should handle this instead of you." },
        escalation_reason: { type: "string", description: "One short phrase, when escalate is true." },
        facts_asserted: {
          type: "array",
          items: { type: "string" },
          description: "Every factual claim your reply makes, quoted. Be exhaustive — this is checked against what you were allowed to say.",
        },
      },
      required: ["intent", "reply_text", "confidence", "escalate", "facts_asserted"],
    },
  },
});

/** The tool NAME is shared across both kinds on purpose: extractToolArguments
 * checks it, and one name means one code path reading the response back. */
const TOOL_NAME = "draft_persona_reply";

/** Everything the model may treat as true. Anything outside this list is, for
 * our purposes, invented — the guard cross-checks `facts_asserted` against it. */
export const APPROVED_FACTS = [
  "Facundo is an international flower delivery service.",
  "A customer in another country orders flowers; a local florist makes and delivers them.",
  "We pay 70% by card at the moment the florist accepts an order, before they buy anything.",
  "The florist sends a photo of the finished bouquet; we check it and release the remaining 30%, before delivery.",
  "There is no fee, no contract, no minimum, and the florist accepts or declines each order individually.",
  "Orders arrive by email or text message.",
  "Joining takes about a minute.",
];

export interface AgentInput {
  personaName: string;
  personaRole: string;
  /** The market's language, so the model knows what "their language" means even
   * when the inbound message is too short to tell. */
  locale: string;
  /** The approved pitch, rendered from the catalog — verbatim. Recruiting only. */
  canonicalPitch?: string;
  /** Oldest first. Keeps the model in the same conversation the florist is in. */
  thread: { direction: "in" | "out"; body: string }[];
  /** Which conversation this is. Defaults to recruiting so existing callers are
   * unaffected. */
  kind?: AgentKind;
  /** Support only: the sentences lib/supportFacts.ts computed for THIS florist's
   * order. The complete set of things the reply may assert about the order. */
  facts?: string[];
  /** Support only: general, published policy/how-to lines
   * (lib/support/publishedHelp.ts), the same for every florist. Kept
   * separate from `facts` on purpose — the money guard's allow-list
   * (allowedAmounts) is built only from `facts`, never from here. */
  helpFacts?: string[];
}

/**
 * The support prompt.
 *
 * Structurally the same bargain as the recruiting one — here is everything you
 * may say, say nothing else — with the source of the facts swapped from a
 * constant to a per-conversation lookup. Three rules carry most of the weight:
 *
 *   1. Never state a figure that is not in the facts. Backed by the guard, so
 *      breaking it produces an escalation rather than a wrong number.
 *   2. Never say what happens next to the MONEY beyond what the facts say. "It
 *      will be paid tomorrow" is a promise about a payment, which is the most
 *      expensive sentence this could write.
 *   3. Hand over rather than guess. A florist waiting ten minutes for a person
 *      costs us nothing; a confident wrong answer about their money costs us
 *      the florist.
 */
/** Concierge's rules and style live in agents/thinking/concierge.md. */
export const CONCIERGE = agentSpec("concierge");
export const CONCIERGE_RULES_HASH = CONCIERGE.rulesHash;
/** Cupid's prompt is still built in code (buildPrompt); its file holds the job. */
export const CUPID = agentSpec("cupid");

/** What one turn was given, stored in conversation_messages.ai_context.
 * Concierge rows written before `agent` existed have no `agent` key. */
export type TurnRunContext =
  | {
      agent: "concierge";
      prompt: string;
      facts: string[];
      helpFacts: string[];
      allowedAmounts: number[];
      rulesHash: string;
    }
  | { agent: "cupid"; prompt: string; canonicalPitch: string | null; rulesHash: string };

export function buildSupportPrompt(input: AgentInput): string {
  const facts = input.facts ?? [];
  const helpFacts = input.helpFacts ?? [];
  return [
    `You are ${input.personaName}, ${input.personaRole} at Facundo. You are answering a florist who is already in our network and is asking about their own order.`,
    "",
    "These are the facts about this florist and this order. They were read from our own records a moment ago:",
    "--- FACTS ---",
    ...facts.map((f) => `- ${f}`),
    "--- END ---",
    "",
    "These are Facundo's published policies and how-to answers. They are the same for every florist, already staff-approved, and apply generally, not just to this order:",
    "--- PUBLISHED POLICY & HOW-TO ---",
    ...helpFacts.map((f) => `- ${f}`),
    "--- END ---",
    "",
    "Hard rules:",
    ...CONCIERGE.rules.map((r) => `- ${r}`),
    "",
    `Style: ${CONCIERGE.style.charAt(0).toLowerCase()}${CONCIERGE.style.slice(1)}`,
    `Write in the florist's own language (their market's language is ${input.locale}).`,
    "",
    "The conversation so far:",
    ...input.thread.map((m) => `${m.direction === "in" ? "FLORIST" : "YOU"}: ${m.body}`),
    "",
    `Call the ${TOOL_NAME} tool. Do not reply in prose.`,
  ].join("\n");
}

export function buildPrompt(input: AgentInput): string {
  if (input.kind === "support") return buildSupportPrompt(input);
  return [
    `You are ${input.personaName}, ${input.personaRole} at Facundo. You write to independent florists who we have contacted about joining our network.`,
    "",
    "This is the approved pitch. It is the ONLY offer that exists:",
    "--- APPROVED PITCH ---",
    input.canonicalPitch,
    "--- END ---",
    "",
    "You may assert these facts and NOTHING else:",
    ...APPROVED_FACTS.map((f) => `- ${f}`),
    "",
    "Hard rules:",
    "- Never state a price, fee, percentage or currency amount that is not in the facts above. If they ask about money beyond the 70/30 split, set intent=question_pricing and escalate.",
    "- Never promise a specific order, a delivery date, or how many orders they will get. We do not know.",
    "- Never agree to contract, invoicing, tax or data-protection terms. Set intent=question_legal and escalate.",
    "- If they ask to be put through to a person, set intent=wants_human and escalate.",
    "- If they ask whether you are a person, a bot, or automated: set intent=asked_if_ai and ANSWER IT. Say plainly that you are an automated assistant, not a person, and offer to hand them to a colleague. Never deny it, never deflect, never answer a different question. This is the one thing you must always be straight about.",
    "- If they ask us to stop contacting them, set intent=opt_out. Do not try to talk them out of it.",
    "- If you are not sure, say so and lower your confidence. A handover to a colleague is always better than a guess.",
    "",
    "Style: write the way a busy person writes a short work email. Plain sentences. No marketing language, no bullet lists, no em dashes. Answer the actual question first.",
    `Write in the florist's own language (their market's language is ${input.locale}).`,
    "",
    "The conversation so far:",
    ...input.thread.map((m) => `${m.direction === "in" ? "FLORIST" : "YOU"}: ${m.body}`),
    "",
    "Call the draft_persona_reply tool. Do not reply in prose.",
  ].join("\n");
}

/** Pull the tool-call arguments out of an OpenAI-compatible response. Returns
 * null when the model answered in prose instead of calling the tool, which the
 * caller treats as a failure rather than trying to salvage free text. */
export function extractToolArguments(json: unknown): unknown | null {
  const call = (
    json as { choices?: { message?: { tool_calls?: { function?: { name?: string; arguments?: unknown } }[] } }[] }
  )?.choices?.[0]?.message?.tool_calls?.[0]?.function;
  if (!call || call.name !== TOOL_NAME) return null;
  const args = call.arguments;
  if (typeof args === "object" && args !== null) return args; // some models return it parsed
  if (typeof args !== "string") return null;
  try {
    return JSON.parse(args);
  } catch {
    return null;
  }
}

export interface AgentResult extends AgentJudgment {
  model: string;
  raw: unknown;
  /** The exact prompt sent, so a run can be recorded and replayed. */
  prompt: string;
  /** The provider's token usage block, when it returned one. */
  usage: unknown | null;
}

export interface DraftArgs {
  input: AgentInput;
  apiKey: string;
  model?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Draft the next reply.
 *
 * THROWS on any failure — no key, timeout, non-200, prose instead of a tool
 * call, or a payload that doesn't validate. The caller catches and escalates to
 * a human, which is the correct failure direction for this feature. */
export async function draftPersonaReply(args: DraftArgs): Promise<AgentResult> {
  const { input, apiKey, model = DEFAULT_CX_AGENT_MODEL, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = args;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const kind: AgentKind = input.kind ?? "recruiting";

  // A support turn with no facts is refused HERE rather than prompted on. An
  // empty fact list plus "say only what is in the facts" is the input most
  // likely to produce a fluent answer with no grounding at all, and the caller
  // is set up to escalate on a throw.
  if (kind === "support" && (input.facts ?? []).length === 0) {
    throw new Error("support draft attempted with no facts");
  }

  const prompt = buildPrompt(input);
  const res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
      tools: [buildTool(kind)],
      tool_choice: { type: "function", function: { name: TOOL_NAME } },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${detail.slice(0, 200)}`);
  }

  const json: unknown = await res.json();
  const rawArgs = extractToolArguments(json);
  if (rawArgs === null) throw new Error("agent did not call the tool");

  const parsed = JudgmentSchema.parse(rawArgs);

  return {
    intent: parsed.intent as AnyIntent,
    // The same post-processing rule the recruiting personaliser applies, using
    // the same helper: an em dash is the most reliable tell that a machine
    // wrote the sentence, and a prompt forbidding them is a request, not a
    // guarantee.
    replyText: stripEmDashes(parsed.reply_text).trim(),
    confidence: parsed.confidence,
    escalate: parsed.escalate,
    factsAsserted: parsed.facts_asserted,
    model,
    raw: rawArgs,
    prompt,
    usage: (json as { usage?: unknown })?.usage ?? null,
  };
}
