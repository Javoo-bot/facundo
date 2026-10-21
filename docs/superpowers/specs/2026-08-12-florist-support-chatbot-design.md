# Florist support chatbot + order-matched inbound mailbox

> Scoping for growing this into a broader florist operations assistant (order
> process coaching, app guidance, published policy, procedural troubleshooting)
> lives in
> `docs/superpowers/specs/2026-08-15-florist-operations-assistant-scope-design.md`.
> Read this support-chatbot architecture doc first; the newer scope doc extends it.

## What this is

One system with two front doors. A florist already in the network can ask about
an order they are holding — in the app, or by replying to the email that order
arrived on — and both land in the same conversation, answered by an agent
grounded in that order's real rows, with anything it may not answer handed to a
person.

## What already existed

More than half of it. `conversations` + `conversation_messages`, inbound email
(Resend Inbound) and SMS (Telnyx), a staff `/conversations` inbox with reply,
`lib/cxAgent.ts` (the AI persona) and `lib/cxAgentGuard.ts` (a deterministic
escalation gate that cross-checks every fact the model claims against an allowed
list).

Four gaps stood between that and this:

1. **No `order_id` on `conversations`.** No order matching at all: a florist
   emailing about a specific order landed in a thread attached to nothing.
2. **`channel` was `check (channel in ('email','sms'))`.** A florist inside the
   app had no way to write anything. `/florist/messages` was a read-only merge of
   `order_issues` + `florist_messages`.
3. **The agent was recruiting-only.** `APPROVED_FACTS` is the join pitch and its
   rules forbid stating any amount, date or order reference. A joined florist
   asking "where's my 30%?" escalated 100% of the time — correctly, given what it
   knew.
4. **Escalations never reached `/cx`.** They set `cx_unread` and appeared on
   `/conversations` alone; `cxAttention.ts` had no idea they existed.

## Decisions

| Question | Chosen | Why |
|---|---|---|
| What may the bot know? | Q&A **plus** the florist's real order data, computed per conversation | It is the only option that answers the question florists actually ask. Anything less escalates most traffic. |
| How is an order matched? | Reply-address token, then header threading, then nothing | Never guesses. Attaching one shop's words to another shop's job is worse than leaving a message unattached. |
| Where does the chat live? | A thread on the order page | Order attribution is explicit rather than inferred, which is the whole point of the matching work. |
| What about `order_issues`? | Untouched | An issue is what moves money. The bot may point at the button; it may not press it. |
| Whose mail? | Florists only | The bot only ever writes to an audience we hold approved facts for. |

## Architecture

```
florist types in the app ─┐
                          ├─→ conversations (kind='support', order_id) ─→ runAgentTurn ─→ reply | escalate
florist replies by email ─┘         ▲                                          │
                              inboundMatch                              supportFacts
                         (token → headers → none)                    (payouts, photo, dates)
```

### `lib/inboundMatch.ts` — which order

1. **Reply-address token.** Order emails go out with
   `Reply-To: r+<token>@<INBOUND_EMAIL_DOMAIN>`, the token an HMAC over the
   **assignment** id — one opaque value settling order and florist together.
   Truncated to 128 bits so the whole local-part fits RFC 5321's 64 octets.
2. **Header threading.** `In-Reply-To` / `References` against
   `communications.rfc_message_id`, a Message-ID we set ourselves at send time.
   Also falls back to Resend's own id, in case Resend substitutes its header.
3. **Nothing.** Attaches to the florist with no order, and escalates.

A match naming a different florist than the sender is **discarded** — that is a
forwarded thread, and it is the one case where a confident match is the harmful
outcome.

`References` is read newest-first; reading it in file order would preferentially
match the oldest email of a long thread.

### `lib/supportFacts.ts` — what may be said

One read per conversation, scoped through the assignment, producing a fact list
and the exact figures it contains. Deliberately excluded: the order total, our
margin, and the customer's name/email/phone — none of which a support answer
needs and all of which would otherwise sit in a prompt to a third-party model.

An empty or single-fact result is reported as `empty`, and the caller escalates
rather than prompting a model with nothing to stand on.

### The guard change

`containsMoneyClaim` refused **any** currency symbol outright. Correct for a
prospect — every number is an offer — and fatal for support.

The replacement is not a relaxation:

```ts
moneyClaimOutsideFacts(text, allowedAmounts)
```

Every money token is normalised across the six markets' decimal conventions and
checked against the figures `supportFacts` read **for this conversation**.
Anything else escalates, exactly as before. `allowed = []` reproduces the old
behaviour byte for byte, which is what recruiting passes and what the regression
test asserts against hand-written expectations.

`70` / `30` / `100` remain sayable as percentages without grounding: they
describe the split, not a payment.

**Not guarded: dates.** There is no reliable way to allow-list a date by pattern
across six languages of month names. The protection is the fact list, the
confidence floor, and the florist seeing the real date on the same screen. A
wrong date is a nuisance; a wrong figure is a payment dispute, so only the figure
gets a hard gate. This is a deliberate limit, not an oversight.

### Two taxonomies

`question_pricing` escalates for a prospect and is answerable for a joined
florist — the same words, opposite handling. So support has its own intent list
and its own escalate set. `delivery_problem` and `change_request` always escalate:
the bot may point at "Report a problem", never file one.

> **Extended 2026-08-15 (product owner):** `change_request` and `question_terms`
> escalating always is about a *live* change or *this florist's own* figures
> — it was never meant to read as "no money/terms/change-shaped question is
> ever answerable." The operations-assistant scope doc adds a disjoint,
> answerable source for *general, published* policy that's the same for every
> florist (the substitution rule, the 70/30 split, payout timing/immediacy,
> payout method) via new intents that join the safe side of the taxonomy —
> `change_request`/`question_terms` themselves are untouched and still always
> escalate. See that doc's "Answerable policy vs. must-escalate live/unknown"
> section for the exact split.

### `lib/agentTurn.ts`

Extracted from `ingestInbound` so the app door and the email door run the same
guards. The channel only decides how the reply leaves; facts, taxonomy, turn cap
and disclosure are identical for all three.

## Rollout

`support_agent_enabled` ships **false**, separate from `cx_agent_enabled`. The
two agents talk to different people about different things and carry different
risk: one can overstate an offer, the other can misstate what we owe a business.

`REPLY_TOKEN_SECRET` and `INBOUND_EMAIL_DOMAIN` are both optional. Until the MX
record exists, `replyToAddress` returns null, order emails ship with the reply-to
they use today, and matching falls back to header threading. Nothing bounces.

## Known limits

- **Message-ID substitution is unverified.** Whether Resend honours a Message-ID
  we set could not be established without sending real mail. The token path is
  primary for this reason, and the provider-id fallback covers the common
  substitution.
- **`x-support-facts-stale`** (open on `/lifecycle`): facts are read, the model
  writes, the payout moves. Seconds-wide, a stale truth rather than an invented
  one. Not solved.
- **No browser verification.** See the PR.

## Not built

The bot writing `order_issues` or moving money; customer-facing inbound; voice;
inbound attachments (an emailed photo escalates).
