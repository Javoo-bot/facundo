import test from "node:test";
import assert from "node:assert/strict";
import {
  draftPersonaReply,
  extractToolArguments,
  buildPrompt,
  APPROVED_FACTS,
  DEFAULT_CX_AGENT_MODEL,
  SUPPORT_INTENTS,
} from "./cxAgent.ts";
import { SUPPORT_ESCALATE_INTENTS } from "./cxAgentGuard.ts";

const INPUT = {
  personaName: "Marta Ruiz",
  personaRole: "Onboarding Manager",
  locale: "es",
  canonicalPitch: "We pay 70% by card when you accept.",
  thread: [{ direction: "in", body: "Can I decline an order?" }],
};

const GOOD = {
  intent: "question_logistics",
  reply_text: "Yes — you can decline any order that doesn't suit you.",
  language: "en",
  confidence: 0.9,
  escalate: false,
  facts_asserted: ["The florist accepts or declines each order individually."],
};

function reply(args, { ok = true, status = 200, name = "draft_persona_reply" } = {}) {
  return async () => ({
    ok,
    status,
    text: async () => "boom",
    json: async () => ({ choices: [{ message: { tool_calls: [{ function: { name, arguments: args } }] } }] }),
  });
}

test("a well-formed tool call is parsed into a judgment", async () => {
  const r = await draftPersonaReply({ input: INPUT, apiKey: "k", fetchImpl: reply(JSON.stringify(GOOD)) });
  assert.equal(r.intent, "question_logistics");
  assert.equal(r.confidence, 0.9);
  assert.equal(r.escalate, false);
  assert.deepEqual(r.factsAsserted, GOOD.facts_asserted);
  assert.equal(r.model, DEFAULT_CX_AGENT_MODEL);
});

test("the result carries the exact prompt sent and the provider's usage", async () => {
  let sent;
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  const fetchImpl = async (_url, init) => {
    sent = JSON.parse(init.body).messages[0].content;
    return {
      ok: true,
      json: async () => ({
        usage,
        choices: [{ message: { tool_calls: [{ function: { name: "draft_persona_reply", arguments: GOOD } }] } }],
      }),
    };
  };
  const r = await draftPersonaReply({ input: INPUT, apiKey: "k", fetchImpl });
  assert.equal(r.prompt, sent);
  assert.equal(r.prompt, buildPrompt(INPUT));
  assert.deepEqual(r.usage, usage);

  const bare = await draftPersonaReply({ input: INPUT, apiKey: "k", fetchImpl: reply(GOOD) });
  assert.equal(bare.usage, null);
});

// The house no-em-dash rule, applied with the shared helper. A prompt forbidding
// them is a request, not a guarantee.
test("em dashes are stripped from the drafted reply", async () => {
  const r = await draftPersonaReply({ input: INPUT, apiKey: "k", fetchImpl: reply(JSON.stringify(GOOD)) });
  assert.ok(!r.replyText.includes("—"), r.replyText);
  assert.ok(r.replyText.includes("Yes: you can decline"), r.replyText);
});

test("arguments already parsed into an object are accepted too", async () => {
  // Some models on OpenRouter return `arguments` as an object rather than a
  // JSON string; both are valid and neither should be a failure.
  const r = await draftPersonaReply({ input: INPUT, apiKey: "k", fetchImpl: reply(GOOD) });
  assert.equal(r.intent, "question_logistics");
});

// Every failure below must THROW, not return null — the caller escalates to a
// human on a throw, and a null could be mistaken for "nothing to say".
test("a missing key throws rather than returning null", async () => {
  await assert.rejects(() => draftPersonaReply({ input: INPUT, apiKey: "", fetchImpl: reply(JSON.stringify(GOOD)) }));
});

test("a non-200 throws, carrying the status", async () => {
  await assert.rejects(
    () => draftPersonaReply({ input: INPUT, apiKey: "k", fetchImpl: reply("{}", { ok: false, status: 402 }) }),
    /402/
  );
});

test("prose instead of a tool call throws — free text is never salvaged", async () => {
  const proseOnly = async () => ({
    ok: true, status: 200, text: async () => "",
    json: async () => ({ choices: [{ message: { content: "Sure, you can decline!" } }] }),
  });
  await assert.rejects(() => draftPersonaReply({ input: INPUT, apiKey: "k", fetchImpl: proseOnly }), /did not call the tool/);
});

test("a tool call under the wrong name is rejected", async () => {
  await assert.rejects(
    () => draftPersonaReply({ input: INPUT, apiKey: "k", fetchImpl: reply(JSON.stringify(GOOD), { name: "something_else" }) }),
    /did not call the tool/
  );
});

test("malformed JSON in the arguments throws", async () => {
  await assert.rejects(() => draftPersonaReply({ input: INPUT, apiKey: "k", fetchImpl: reply("{not json") }), /did not call the tool/);
});

test("a payload missing required fields fails validation", async () => {
  const { confidence, ...missing } = GOOD;
  void confidence;
  await assert.rejects(() => draftPersonaReply({ input: INPUT, apiKey: "k", fetchImpl: reply(JSON.stringify(missing)) }));
});

test("an unrecognised intent fails validation rather than being sent", async () => {
  await assert.rejects(
    () => draftPersonaReply({ input: INPUT, apiKey: "k", fetchImpl: reply(JSON.stringify({ ...GOOD, intent: "vibes" })) })
  );
});

test("extractToolArguments returns null on every shape it can't read", () => {
  for (const j of [null, undefined, {}, { choices: [] }, { choices: [{ message: {} }] }, { choices: [{ message: { tool_calls: [] } }] }]) {
    assert.equal(extractToolArguments(j), null, JSON.stringify(j));
  }
});

// ---- the prompt ----

test("the prompt carries the approved pitch and the fact list verbatim", () => {
  const p = buildPrompt(INPUT);
  assert.ok(p.includes(INPUT.canonicalPitch), "lost the catalog-rendered pitch");
  for (const f of APPROVED_FACTS) assert.ok(p.includes(f), `lost an approved fact: ${f}`);
  assert.ok(p.includes("Marta Ruiz"), "lost the persona");
  assert.ok(p.includes("FLORIST: Can I decline an order?"), "lost the thread");
});

test("the prompt names every escalation the guard also enforces", () => {
  const p = buildPrompt(INPUT);
  for (const s of ["question_pricing", "question_legal", "wants_human", "opt_out"]) {
    assert.ok(p.includes(s), `prompt never mentions ${s}`);
  }
});

test("the model is a config value, overridable per call", async () => {
  const r = await draftPersonaReply({
    input: INPUT, apiKey: "k", model: "anthropic/claude-haiku-4-5", fetchImpl: reply(JSON.stringify(GOOD)),
  });
  assert.equal(r.model, "anthropic/claude-haiku-4-5");
});

test("the request is an OpenRouter tool call, not a prose completion", async () => {
  let seen = null;
  const capture = async (_url, init) => {
    seen = { url: _url, body: JSON.parse(init.body) };
    return { ok: true, status: 200, text: async () => "", json: async () => ({ choices: [{ message: { tool_calls: [{ function: { name: "draft_persona_reply", arguments: JSON.stringify(GOOD) } }] } }] }) };
  };
  await draftPersonaReply({ input: INPUT, apiKey: "k", fetchImpl: capture });
  assert.match(seen.url, /openrouter\.ai\/api\/v1\/chat\/completions/);
  assert.equal(seen.body.tool_choice.function.name, "draft_persona_reply");
  assert.equal(seen.body.tools[0].type, "function");
  assert.equal(seen.body.model, DEFAULT_CX_AGENT_MODEL);
});

test("a recruiting reply may restate the approved 70/30 split without escalating as question_pricing", async () => {
  let seen = null;
  const capture = async (_url, init) => {
    seen = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => "", json: async () => ({ choices: [{ message: { tool_calls: [{ function: { name: "draft_persona_reply", arguments: JSON.stringify(GOOD) } }] } }] }) };
  };
  await draftPersonaReply({ input: INPUT, apiKey: "k", fetchImpl: capture });
  const description = seen.tools[0].function.parameters.properties.intent.description;
  // cupid.md's job and the prompt's own hard rule both say "beyond 70/30" —
  // the tool schema's intent description must draw the same line, not a
  // broader one that escalates every mention of money.
  assert.ok(
    !/\bANY\b.*question about money/i.test(description),
    "the model must not be told to treat every money mention as question_pricing"
  );
  assert.match(
    description,
    /beyond the 70\/30 split/i,
    "the question_pricing boundary must match the approved pitch's 70/30 split, same as cupid.md and the prompt's hard rule"
  );
});

// ---------------------------------------------------------------------------
// The support variant: same machinery, per-conversation facts.
// ---------------------------------------------------------------------------

const FACTS = [
  "This conversation is about order #1042.",
  "The 70% payment, due on acceptance, is 84.50 EUR, and it has been sent to the florist's card.",
];

const supportInput = {
  personaName: "Marta Ruiz",
  personaRole: "Onboarding Manager",
  locale: "es",
  kind: "support",
  facts: FACTS,
  thread: [{ direction: "in", body: "¿Cuándo me pagáis?" }],
};

test("the support prompt carries published-help lines, separately from order facts", () => {
  const HELP = ["Q: How and when do I get paid? A: 70% on accept, 30% on the photo."];
  const p = buildPrompt({ ...supportInput, helpFacts: HELP });
  assert.ok(p.includes("PUBLISHED POLICY & HOW-TO"), "missing the published-help section header");
  for (const f of HELP) assert.ok(p.includes(f), `lost a published-help line: ${f}`);
  // Order facts still render in their own, separate section.
  for (const f of FACTS) assert.ok(p.includes(f), `lost an order fact: ${f}`);
});

test("a recruiting draft never sees helpFacts even if a caller passed them by mistake", () => {
  const p = buildPrompt({
    personaName: "Marta", personaRole: "Onboarding", locale: "es",
    canonicalPitch: "the pitch", thread: [{ direction: "in", body: "hola" }],
    helpFacts: ["Q: leak? A: this must never appear on the recruiting path."],
  });
  assert.ok(!p.includes("PUBLISHED POLICY"), "recruiting prompt must not carry the support help-facts block");
  assert.ok(!p.includes("this must never appear"));
});

test("the support tool now offers process_explain and app_howto", async () => {
  let body = null;
  await draftPersonaReply({
    input: supportInput,
    apiKey: "k",
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { tool_calls: [{ function: { name: "draft_persona_reply", arguments: JSON.stringify({ intent: "app_howto", reply_text: "Puedes aceptar el pedido desde la app.", confidence: 0.9, escalate: false, facts_asserted: [] }) } }] } }],
        }),
      };
    },
  });
  const enumerated = body.tools[0].function.parameters.properties.intent.enum;
  assert.ok(enumerated.includes("process_explain"));
  assert.ok(enumerated.includes("app_howto"));
});

test("the support prompt carries the computed facts verbatim", () => {
  const p = buildPrompt(supportInput);
  for (const f of FACTS) assert.ok(p.includes(f), `missing fact: ${f}`);
});

test("the support prompt does NOT carry the recruiting pitch", () => {
  // The two fact sets must never appear together. A joined florist being
  // re-pitched the joining offer is the tell that the kinds have crossed.
  const p = buildPrompt(supportInput);
  for (const f of APPROVED_FACTS) assert.ok(!p.includes(f), `leaked recruiting fact: ${f}`);
  assert.ok(!p.includes("APPROVED PITCH"));
});

test("the support prompt names every escalation the guard enforces", () => {
  // Drift between the prompt's instructions and SUPPORT_ESCALATE_INTENTS means
  // the model is told to answer something the guard will refuse to send — a
  // silent escalation queue nobody can explain.
  const p = buildPrompt(supportInput);
  for (const intent of ["change_request", "delivery_problem", "question_terms", "opt_out", "asked_if_ai"]) {
    assert.ok(p.includes(intent), `prompt never mentions ${intent}`);
  }
});

test("the two intent taxonomies stay in step across the two files", () => {
  // cxAgent offers the enum to the model; cxAgentGuard decides what to do with
  // what comes back. An intent in one and not the other is either an option the
  // guard has no rule for, or a rule that can never fire.
  //
  // Derived from SUPPORT_ESCALATE_INTENTS until 2026-08-12, when that list was
  // emptied so support replies auto-send. The taxonomy itself did not change —
  // only what the guard does with each label — so it is spelled out here
  // instead, and this test goes on catching an intent added to one file and not
  // the other.
  const guardIntents = new Set([
    "order_status", "payout_status", "photo_help", "process_explain", "app_howto", "asked_if_ai",
    "delivery_problem", "change_request", "question_terms", "complaint",
    "wants_human", "opt_out", "unclear",
  ]);
  assert.deepEqual([...SUPPORT_INTENTS].sort(), [...guardIntents].sort());
  // Every label the model may return must still be one the guard has a rule
  // for, even when that rule is now "send".
  for (const intent of SUPPORT_ESCALATE_INTENTS) assert.ok(guardIntents.has(intent), intent);
});

test("a support draft with no facts throws instead of prompting on an empty list", async () => {
  // "Say only what is in the facts" plus no facts is the input most likely to
  // produce a fluent, ungrounded answer. The caller catches and escalates.
  await assert.rejects(
    () => draftPersonaReply({ input: { ...supportInput, facts: [] }, apiKey: "k", fetchImpl: async () => { throw new Error("must not be called"); } }),
    /no facts/
  );
});

test("the support tool offers only the support taxonomy", async () => {
  let body = null;
  await draftPersonaReply({
    input: supportInput,
    apiKey: "k",
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { tool_calls: [{ function: { name: "draft_persona_reply", arguments: JSON.stringify({ intent: "payout_status", reply_text: "Ya está pagado.", confidence: 0.9, escalate: false, facts_asserted: [] }) } }] } }],
        }),
      };
    },
  });
  const enumerated = body.tools[0].function.parameters.properties.intent.enum;
  assert.ok(enumerated.includes("payout_status"));
  // The recruiting intent whose meaning INVERTS between the two kinds. Offering
  // it here would route a money question into a list that does not escalate it.
  assert.ok(!enumerated.includes("question_pricing"));
});

test("a recruiting draft is unchanged and still offers the recruiting taxonomy", async () => {
  let body = null;
  await draftPersonaReply({
    input: {
      personaName: "Marta", personaRole: "Onboarding", locale: "es",
      canonicalPitch: "the pitch", thread: [{ direction: "in", body: "hola" }],
    },
    apiKey: "k",
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { tool_calls: [{ function: { name: "draft_persona_reply", arguments: JSON.stringify({ intent: "interested", reply_text: "hola", confidence: 0.9, escalate: false, facts_asserted: [] }) } }] } }],
        }),
      };
    },
  });
  const enumerated = body.tools[0].function.parameters.properties.intent.enum;
  assert.ok(enumerated.includes("question_pricing"));
  assert.ok(!enumerated.includes("payout_status"));
  assert.ok(body.messages[0].content.includes("APPROVED PITCH"));
});
