---
id: cupid
nick: Cupid
emoji: 💌
name: Recruiting reply agent
system: recruiting
stage: auto
prompt_source: code
model: anthropic/claude-sonnet-5
switch: app_settings.cx_agent_enabled
entry: dashboard/lib/agentTurn.ts#runAgentTurn
call_sites:
  - dashboard/lib/cxAgent.ts
---

## Job

Reply to a florist shop we contacted about joining. Use the approved pitch
and the approved facts only, and hand over anything about money beyond 70/30,
legal terms, or a request for a person.

## Rules

Still in code (`buildPrompt` in `dashboard/lib/cxAgent.ts`). Moves here when
Cupid gets its own turn, after Concierge.

## Style

Short work email, plain sentences, the florist's own language, no em dashes.

## Checked by code, whatever this file says

Same guard as Concierge, with no allowed money amounts: any figure escalates.

## Sees by default

The approved pitch, the approved facts and the thread.

## Can fetch on demand

Nothing.

## What good looks like

Never part of the prompt. Read by the factory: see
`docs/agent-factory/agent-minimums.md`.

### money-and-contract-handover
- Means: Every reply Cupid labels as a question about money or terms goes to a person instead of being sent.
- Data: `conversation_messages` on recruiting conversations with `ai_generated` true and `ai_intent` question_pricing or question_legal; it counts as handed over when `status` is draft, not sent.
- Minimum: at least 100%
- Window: rolling 7 days, at least 1 case
- Kind: decides
- Measurable: now. The guard already escalates these intents, so this catches a guard regression; a money question Cupid labels as something else shows up only in operator-agreement.

### operator-agreement
- Means: When a reply is stopped for a person, the person sends it as Cupid wrote it. Sent unchanged is agreement, changed is disagreement; a thread closed with no reply does not count.
- Data: `operator_decisions` rows for cupid (approved = agree, changed = disagree), being built. Until it lands, the same fact from `conversation_messages` on recruiting conversations: an AI draft (`ai_generated` true, `status` draft) and the next staff reply in that conversation (`ai_generated` false, `direction` out); the same `body_text` after trimming is agreement.
- Minimum: at least 90%
- Window: rolling 7 days, at least 10 cases
- Kind: decides
- Measurable: now, from the conversation_messages stand-in, which only sees the replies the guard stopped.

### tone
- Means: A sent reply reads friendly and short to a shop we are recruiting.
- Data: the garden tone check (`agents/garden/tone/geval.py`, DeepEval G-Eval, 0 to 1) on Cupid's sent replies (recruiting conversations), written to `tone.json` in the daily garden report.
- Minimum: at least 0.7
- Window: rolling 7 days, at least 5 cases
- Kind: advice
- Measurable: now, garden only. At most 5 messages a day across Concierge and Cupid.
