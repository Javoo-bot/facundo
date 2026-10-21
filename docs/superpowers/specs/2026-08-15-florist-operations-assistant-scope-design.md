# Florist operations assistant — knowledge/product scope

**Date:** 2026-08-15
**Status:** scope brief — not yet a build plan. Use this to size and sequence
the implementation; write a normal dated design doc for whichever slice ships
first.

## Why this doc exists

The florist support chatbot
(`docs/superpowers/specs/2026-08-12-florist-support-chatbot-design.md`) shipped
answering three things: where's my order, what have I been paid, how do I send
the photo. the product team want to grow it into something a florist can lean
on for the whole relationship with Facundo — not just "read me a row from
the database" but "help me understand and run this job." That's a materially
bigger promise, and this doc exists to scope it *before* anyone writes code,
because the honest failure mode here isn't "the bot is unhelpful" — it's "the
bot answers confidently about something it shouldn't have opined on," and the
existing architecture was deliberately built to make that hard. Anything added
has to extend that architecture, not go around it.

## Product framing

**Not a generic chatbot.** A florist-facing operations assistant: it knows
this florist's order, this florist's app, and Facundo's own published
policies and process — and it knows the edge of that knowledge precisely
enough to hand off instead of guess. The bar for "good" isn't eloquence, it's
the same bar the existing support agent was held to: every claim traceable to
something we actually stored or actually published, and everything else
routed to a person.

Five capability buckets, as framed by the product team:

| Bucket | What it means here |
|---|---|
| **Order Coach** | Explains the order lifecycle and where *this* order sits in it — offer → accept → fulfil → photo → paid — and what happens next. |
| **App Guide** | Walks the florist through using the Facundo app itself: accepting, installing, finding the recipe, sending the photo, teammates, language. |
| **Policy Assistant** | Restates *published, staff-approved* policy — the 70/30 split, substitution rules, what's expected of a delivery photo — never invents or infers policy. |
| **Troubleshooter** | Resolves procedural confusion ("I can't find the accept button," "my photo won't upload") without touching order state or money. |
| **Florist Success Coach** | Proactive, performance-oriented coaching. Out of scope for this doc's v1 — see [Non-goals](#v1-scope). |

## What the assistant knows vs. does vs. must escalate

This is the load-bearing distinction, and it maps directly onto the existing
`lib/agentTurn.ts` / `lib/cxAgentGuard.ts` split between *category* escalation
(decided on intent, before the text exists) and *text* backstops
(`moneyClaimOutsideFacts`, `containsPromise`, disclosure).

- **Knows** — two disjoint sources, and the assistant must never blend them:
  1. **Per-order facts**, read live from the database and scoped to one
     assignment (`lib/supportFacts.ts::loadSupportFacts`) — order name,
     delivery date/window, acceptance date, delivery address/recipient (only
     once accepted — the same PII gate `app/florist/(app)/orders/[id]/page.tsx`
     enforces), payout leg amounts and status, photo verdict, whether a
     problem is already open on this order.
  2. **Published florist-facing knowledge**, staff-authored and already
     reviewed for exactly this audience — today that's
     `dashboard/lib/help/content.ts` (the help-centre articles) plus the
     onboarding walkthrough at `dashboard/app/florist/guide/page.tsx`. Nothing
     the assistant says about "how the app works" or "how the split works"
     should originate anywhere else — not from internal specs, not from the
     model's own inference about how a florist SaaS "probably" works.
- **Does** — drafts a reply, sends it unread if every guard clears (or leaves
  it as an approvable draft on `/cx` if not). It never performs an action:
  never opens an `order_issue`, never changes assignment state, never touches
  a payout. Same rule the support agent already lives by: *"the bot may point
  at the button; it may not press it"* (`2026-08-12` design doc).
- **Must escalate** — anything that is (a) about a specific problem with a
  real, in-flight order, (b) a request to *actually make* a change to a real
  order (date, price, who's doing it, an offer's terms, a live substitution
  on the bouquet in front of them right now), (c) a question about *this
  florist's own* commission, contract terms, tax, or data, (d) a complaint, an
  explicit request for a human, or an opt-out, or (e) the model itself is
  unsure. This is exactly today's `SUPPORT_ESCALATE_INTENTS`
  (`dashboard/lib/cxAgentGuard.ts:125-133`) — **the v1 build for the new
  buckets must not remove or weaken a single one of these seven**, and per the
  brief for this doc, must not weaken any of the underlying category logic
  either.
  - **Correction (2026-08-15, product owner):** (b) and (c) are about *this specific
    order or this specific florist's numbers*, not about published policy in
    general. The bot can and should answer general, published questions about
    money/terms/change-requests when the answer is the same for every florist
    and already staff-reviewed — see [Answerable policy vs. must-escalate
    live/unknown](#answerable-policy-vs-must-escalate-liveunknown) below. An
    earlier draft of this doc read as "all change requests and all
    terms/money/contract questions always escalate," which overstated the
    restriction; the intent categories themselves (`change_request`,
    `question_terms`) are unchanged and still always escalate — what's
    corrected here is that a general policy question is *not* automatically
    one of those two intents in the first place.

### Answerable policy vs. must-escalate live/unknown

Three buckets, not two. Getting this triage right is the actual v1 work — see
[Risks](#risks-and-quality-gates).

1. **Answerable — published policy, general to every florist.** Sourced only
   from `lib/help/content.ts` (or the guide page), restated verbatim/near-
   verbatim. Concretely, in scope for v1:
   - **The allowed substitution rule.** A florist may swap a flower for
     another (never a rose) if the replacement is similar in shape and
     colour, *or* if the swap doesn't change the overall character of the
     bouquet; either way, substitutions are capped at up to 30% of the
     bouquet's composition. This is the corrected rule as of 2026-08-15
     (product owner) — it replaces the older, narrower "similar colour, one
     substitution per bouquet" wording; see the [2026-08-10 help-centre
     doc](2026-08-10-florist-help-centre-design.md)'s Article set section,
     now updated to match, and `lib/i18n/messages/*.ts`'s `missing-flower`
     article (all six locales).
   - **How florists get paid, how much, when, and whether it's immediate.**
     The 70/30 split, that it's paid on the Facundo card, that 70% releases
     the moment the order is accepted (not after delivery) and the remaining
     30% releases once the delivery photo is approved. All of this is
     published today in the `getting-paid` and `the-card` help articles.
   - **Whether the payout method can be changed.** The honest, published
     answer is: the Facundo card is the only payout method offered today;
     a florist who needs something different is pointed at support to ask,
     which is *itself* an answerable statement of policy, not an escalation
     of a live change. (If they go on to actually request a change, that
     next turn is `change_request` and escalates — see point 2.)
2. **Must escalate — a live change or problem on a real order.** "Can I swap
   this specific rose bouquet on order #1234 right now" (a live decision,
   even if the general rule would allow it), "can you change my payout method
   for this payout," "why was my commission different this month than usual,"
   an actual date/price/assignment change request. These stay
   `delivery_problem` / `change_request` / `question_terms` exactly as today.
   The general/published-policy answer above may still be *restated* here
   ("the rule allows up to 30%, similar shape and colour, no roses") as
   context alongside the escalation, per the existing "the assistant may
   explain *how* rescheduling works if that's published, but may not attempt
   or promise the change itself" pattern already in this doc's Order Coach
   example — it just doesn't get to also authorize or record the change.
   **Also note:** even an allowed substitution on a real, in-flight order
   still needs to go through "Report a problem" (per the help-centre article)
   so the change is recorded and the customer is informed — the chat
   confirming "yes, that's within policy" doesn't substitute for that step.
3. **Must escalate — unknown/unpublished.** Anything about money, terms, or a
   change that ISN'T already published florist-facing content (this florist's
   actual commission this month, contract-specific terms, anything not in
   `lib/help/content.ts`). No change from the original scope here: `unclear`
   /`question_terms` catches this, and the model must not infer or guess.

## Responsibility matrix

| Area | Knows | Answers directly (v1) | Escalates / hands off |
|---|---|---|---|
| **Order lifecycle / process** | Which stage this order is at (offer → accept → fulfil → photo → paid); what happens next at each stage | "Where is my order?" · "What happens after I accept?" · "When do I get the rest?" · "What do I need to send next?" | Anything implying the process *should* be different for this order — a date change, an early payout, a re-offer |
| **Florist app usage** | Every published help-centre article + guide page content: accepting, install, recipe, photo upload, working language, teammates, account | "How do I accept an order?" · "How do I install the app?" · "Where do I see the recipe / ingredient list?" · "How do I add a teammate?" | A bug report ("the accept button doesn't do anything") — that's a troubleshooting *technical* case (see below), not a how-to |
| **Working methodology / expectations** | **Not currently documented as florist-facing content.** The closest published material is the substitution rule and photo requirements in the help centre; there is no broader "how Facundo expects a shop to operate" document. | Only what's already published (substitution, photo standards) | Anything asked beyond what's published — flag as an **unknown/gap**, see below |
| **Common order execution problems** | Which problems are "guidance" (procedural, no order-state change) vs. "execution" (something is materially wrong with the order) | "I can't find where to upload the photo" · "How do I mark it delivered?" · "My magic link expired, what do I do?" | "The recipient isn't answering," "I'm missing a flower," "the address is wrong" — these are `delivery_problem` today and must stay `delivery_problem`: they need an `order_issue`, which only a human (or the "Report a problem" button, never the chat) can open |
| **Policy boundaries** | Published policy only: 70/30 split, the corrected substitution rule (no roses; similar shape+colour OR unchanged bouquet character; up to 30% of composition), payout timing/immediacy, payout method (Facundo card, only method offered today), no invoices, photo requirements, what Facundo costs | Restating the above, verbatim or near-verbatim — including "how do I get paid," "how much," "when," "is it immediate," and "can the payout method change" (answer: card-only today, contact support to ask) | A *live* decision or change on a real order (an actual substitution happening right now, an actual payout method change) or anything about *this florist's specific* commission, contract terms, tax, or data — stays `delivery_problem` / `change_request` / `question_terms`, always escalates |
| **Success coaching / quality** | Not built. No performance-history data model exists for this. | Nothing in v1 | Everything — see [Non-goals](#v1-scope) |

## v1 scope

Per the brief, v1 is exactly three things:

1. **Explain the order process** — Order Coach, grounded in the order's real
   assignment/payout state, restating what stage it's at and what's next.
   Mostly additive to `supportFacts.ts` (see [Required
   facts](#required-support-facts--data) below) plus a couple of new
   *answerable* intents.
2. **Help use the app** — App Guide, grounded in the *existing* help-centre
   content (`lib/help/content.ts`) and guide page copy. This is largely a
   grounding-source problem, not a new-guard problem: the content already
   exists and is already staff-reviewed for this audience; the work is making
   it retrievable inside a chat turn instead of only a standalone page.
3. **Solve common order execution problems** — Troubleshooter, but scoped
   tightly to *procedural* problems (can't find a control, don't understand a
   step, a link expired) as opposed to *substantive* order problems (something
   is wrong with the flowers, the address, the recipient). The former is
   answerable; the latter is `delivery_problem` today and must remain so.

### Non-goals for v1

- **Florist Success Coach** in full — proactive, performance-based coaching
  ("your acceptance rate dropped," "here's how to improve your photo pass
  rate"). This isn't a scoping detail, it's a different kind of product:
  today's assistant only ever *replies* inside `runAgentTurn`, which fires on
  an inbound florist message — there is no proactive-send path, no
  performance-history data model, and turning "you're underperforming" into an
  unattended automated message to a small-business partner is a different risk
  class from answering a question they asked. Needs its own product/policy
  sign-off before scoping, not a subsection of this doc.
- **Working methodology beyond what's published.** If there's an expectation
  of florists (turnaround times beyond the offer window, quality bar beyond
  "up to 30% similar shape/colour substitution," expected communication norms) that
  isn't already in the help centre or the offer/order UI copy, the assistant
  has nothing honest to say about it. **This is a real content gap, not an
  engineering one** — flag to product/CX before building the Policy Assistant
  bucket, because "the assistant should know our working methodology" implies
  that methodology is written down somewhere florist-facing, and as far as
  this repo shows, it currently isn't.
- **Any policy content not already published to florists.** The assistant
  must not read internal specs (this repo's `docs/superpowers/specs/`,
  matching-tier definitions, cold-offer caps, our margin) and paraphrase them
  as if they were florist-facing policy. `supportFacts.ts` already draws this
  line for order data (order total and our margin are deliberately excluded);
  the same principle extends to process/policy content — only what a florist
  could already read on `/help` or `/florist/guide` is fair game.
- **Resolving substantive order problems.** Wrong address, missing flower,
  recipient unreachable, "can I substitute this" as a live decision (as
  opposed to reciting the *general* substitution rule) — all stay
  `delivery_problem`/`change_request` and escalate. No weakening.
- **Anything that writes to `order_issues`, changes assignment state, or moves
  money.** Unchanged from today.

## Conversation examples

Written in the existing support taxonomy
(`dashboard/lib/cxAgentGuard.ts::SupportIntent`), with proposed *new*
intents marked `[new]`.

**Order Coach — answerable**
> Florist: "I accepted this one yesterday, what happens now?"
> Assistant: "You're all set — the recipe and ingredient list are in the app
> under this order. Once you've delivered, upload one clear photo of the
> finished bouquet; the remaining 30% releases once that's checked."
> `intent: order_status` (existing) or `process_explain [new]` — grounded in
> `supportFacts` acceptance date + the existing "30% not yet scheduled" line.

**App Guide — answerable**
> Florist: "How do I add my assistant so she can see orders too?"
> Assistant: (restates the `teammates` help-centre article)
> `intent: app_howto [new]` — grounded in `lib/help/content.ts`'s `teammates`
> article, not `supportFacts` (no order-specific figures involved).

**Troubleshooter — answerable**
> Florist: "The link in my email says it expired, how do I get back in?"
> Assistant: points at re-requesting a magic link / signing in directly.
> `intent: app_howto [new]` or `troubleshoot_howto [new]` — no order state
> touched.

**Order Coach — must escalate**
> Florist: "Can you move the delivery to Thursday instead?"
> `intent: change_request` (existing, unchanged) → escalates. The assistant
> may explain *how* rescheduling works if that's published, but may not
> attempt or promise the change itself.

**Troubleshooter → actually a substantive problem — must escalate**
> Florist: "I'm at the address and there's no one home."
> `intent: delivery_problem` (existing, unchanged) → escalates, and per
> `OrderChat.tsx`'s existing design, the chat should route this to the real
> "Report a problem" control rather than let the assistant draft prose about
> it — free text cannot open an `order_issue`, and an `order_issue` is what
> actually moves money.

**Policy Assistant — answerable**
> Florist: "Can I swap a flower I'm out of for something else?"
> Assistant: restates the published rule — never roses; the replacement must
> be similar in shape and colour, or the swap must not change the bouquet's
> overall character; either way, up to 30% of the bouquet's composition, no
> more; report it via Report a problem so the customer is informed.
> `intent: app_howto [new]` — general policy, no specific order named.
>
> Florist: "How and when do I get paid, and can I get it a different way?"
> Assistant: restates the published rule — 70% releases immediately on
> accept, the remaining 30% on photo approval, paid via the Facundo card,
> which is the only payout method offered today; if that doesn't work for
> their shop, contact support to ask.
> `intent: app_howto [new]` — general policy, not this florist's actual
> payout figures (those stay `payout_status`, reading `supportFacts`).

**Policy Assistant — must escalate (live decision on a real order)**
> Florist: "I'm out of roses for THIS order, can I use something else?"
> `intent: delivery_problem` (existing, unchanged) → escalates, even though
> the general rule is answerable, because this is a live decision on a real,
> in-flight order (and the rule forbids substituting roses at all — the
> assistant may say so, but the resolution still needs "Report a problem").
>
> Florist: "Can you switch my payout to a bank transfer for this one?"
> `intent: change_request` (existing, unchanged) → escalates. The assistant
> may explain that the card is the only method offered today, but may not
> promise or process an exception.

**Policy Assistant — must escalate (unpublished/florist-specific)**
> Florist: "Why was my commission different this month than usual?"
> `intent: question_terms` (existing, unchanged) → escalates. No published
> content covers a specific florist's own numbers beyond what `supportFacts`
> already reads for a specific order.

**Success Coach — out of scope, would escalate/no-op today**
> Florist never asks this — it would be a proactive message from us. Not
> built; see Non-goals.

## Required support facts / data

Already available today (`lib/supportFacts.ts::buildSupportFacts`), reusable
as-is for Order Coach:

- Order name, delivery date/window, acceptance date, delivered date
- Delivery address + recipient name/phone (post-accept only)
- Payout leg amount/status/currency for both legs, with plain-English "why"
- Photo verdict (`pass` / `review` / `fail` / not yet received)
- Whether a problem is already open (`hasOpenIssue`) — the hard stop for every
  bucket, not just today's

Notable and currently **unused**: `loadSupportFacts` already selects
`order_assignments.status`, but `AssignmentRow` (line 50-54) never declares
the field and `buildSupportFacts` never reads it. If Order Coach needs a
plain-language "what stage is this order at" sentence, this is very likely the
right field to wire through rather than adding a new query — worth checking
during implementation whether `status`'s possible values already map cleanly
to the offer→accept→fulfil→photo→paid stages this bucket wants to narrate.

New, for the buckets this doc scopes:

- **A deterministic topic → published-content lookup**, keyed off the new
  `app_howto` / `process_explain` style intents, sourced from
  `lib/help/content.ts` (and/or the guide page copy) — *not* a new fact per
  se, since it's order-independent, but it needs the same "here is exactly
  what you may say" discipline `supportFacts` already applies. Concretely:
  whatever intent classifies as "how do I use the app" or "what's the
  policy on X" should retrieve the matching help-centre article(s) and hand
  the assistant that text as its only source — the same shape as `facts:
  string[]` today, just from a different table.
- Nothing new is required for the Troubleshooter bucket beyond what's above:
  procedural troubleshooting is really App Guide content wearing a different
  hat ("how do I..." vs "why won't..." are the same knowledge, different
  phrasing).
- Explicitly **not** needed for v1: any performance/history aggregate
  (acceptance rate, photo pass rate over time, lifetime order count) — that's
  Success Coach territory and out of scope.

## Integration with the existing support-agent architecture

The new buckets are additive to `runAgentTurn`
(`dashboard/lib/agentTurn.ts`), not a parallel system:

1. **New `SupportIntent` values, added to the safe side only.** Something
   like `app_howto` and `process_explain` (naming TBD at implementation time)
   join the union in `dashboard/lib/cxAgentGuard.ts` and get guidance strings
   in `INTENT_GUIDANCE` (`dashboard/lib/cxAgent.ts:57-61`) — mirroring how
   `order_status` / `payout_status` / `photo_help` are described today. They
   must **not** be added to `SUPPORT_ESCALATE_INTENTS`
   (`cxAgentGuard.ts:125-133`); that list stays exactly as hardened on
   2026-08-15 (the "Harden support agent handoff gates" change).
2. **Every existing backstop still applies to the new intents, with no
   exemption.** `moneyClaimOutsideFacts`, `containsPromise`,
   `replyDisclosesAi`, the turn cap, the confidence floor, and — critically —
   `ctx.openIssue` winning over everything else. A florist asking a pure
   how-to question on an order that already has a colleague working an open
   issue still gets handed over, exactly like today.
3. **Two grounding sources must stay separate.** `allowedAmounts` (the
   money-claim allow-list) must keep coming *only* from `supportFacts` —
   order-specific, live figures. The new published-content lookup must never
   feed `allowedAmounts`, and ideally should avoid stating bare currency
   figures at all (mirroring how the help centre already prefers percentages
   — "the 70/30 split" — to named amounts), so a generic policy explanation
   can never accidentally get treated as this order's real numbers.
4. **This is entirely inside `kind='support'`.** Per this repo's
   Production-vs-Recruiting split, none of this touches `kind='recruiting'`
   or `APPROVED_FACTS` (`lib/cxAgent.ts`) — a florist who hasn't joined yet
   doesn't get Order Coach or App Guide through this path; the `eligible`
   check in `agentTurn.ts:207` (support → `!!florist.joined_at`) already
   enforces that and should be left alone.
5. **Escalation still stores a draft, never drops silently.** The existing
   `decision.action === "escalate"` branch in `agentTurn.ts:233-239` inserts
   the drafted (refused) reply as `status: "draft"` before escalating, so CX
   can approve it in one click. Any new bucket's escalated turns get this for
   free as long as they go through the same function — a reason not to build
   a parallel "operations assistant" pipeline alongside `runAgentTurn`.
6. **`/lifecycle` moves with this.** Per `CLAUDE.md`, shipping any of this
   should update `dashboard/lib/lifecycle.ts` — most directly the
   `florist-accept` stage's `accept-has-questions` branch (currently "handled
   by the Q&A link"), which would need to note that some of those questions
   are now answered inline in the order chat rather than only by a link out.

## Knowledge-base structure (build later, not now)

Nothing here should be built as part of this scope doc. Recording the shape
for whoever picks it up:

- **Reuse, don't fork, `lib/help/content.ts`.** It's already: staff-editable
  through the existing override layer (`tWithOverrides` /
  `message_overrides`, same as `/email-templates` and `/faq`), localized in
  all six markets, and organized by exactly the categories this doc's buckets
  need (`app`, `money`, `orders`, `about`). A new `lib/support/knowledgeBase.ts`
  should probably be a thin adapter — topic-classification → article
  id(s) → plain lines for the prompt — rather than a second content system.
- **New guard fixtures, not a new guard file.** Extend
  `dashboard/lib/cxAgentGuard.test.mjs` with cases for the new intents: both a
  "sends" case (grounded, in-scope) and an "escalates" case (out of scope, or
  the seven existing hard-stop intents still catching the same message
  wording). The whole point of the 2026-08-15 hardening work was making these
  explicit and tested; new intents inherit that obligation.
- **`supportFacts.test.mjs`** gets fixtures for whatever new field (e.g.
  `assignment.status`) gets wired through, following the existing pattern of
  asserting exact output lines from fixture rows.
- **A small "published-content coverage" test**, mirroring
  `content.test.mjs`'s existing job of keeping the help centre and its editor
  in sync — if the new lookup only covers a subset of `lib/help/content.ts`'s
  articles, that subset should be asserted, not implicit, so nobody adds a
  help article and forgets the chat can't see it.

## Risks and quality gates

- **Intent misclassification is the whole risk surface.** Almost everything
  else in this system (fact scoping, money guard, disclosure) already exists
  and is tested; the actual new risk is the model drawing the line wrong
  between "general policy question" and "this specific order, right now" —
  see the substitution example above. Mitigation: the `INTENT_GUIDANCE` prompt
  text for the new intents needs to say explicitly "if this is about THIS
  order's current state, not general policy, use `delivery_problem` /
  `change_request` instead" — and that distinction needs adversarial test
  cases (a policy question and a same-topic order-specific question, back to
  back) in the guard fixtures, not just one happy-path example each.
- **Content drift between the help centre and chat answers.** If the chat
  paraphrases rather than quotes, wording can drift from the staff-approved
  article over time in a way nobody notices (the help centre's own design doc
  flags a version of this same risk for its own content). Mitigation: prefer
  handing the model the article text as close to verbatim as the
  `supportFacts` pattern already does for order figures, rather than a
  loose summary the model regenerates each time.
- **Scope creep into "policy" that isn't actually published anywhere.** Flagged
  above as a content gap (working methodology). Building the Policy Assistant
  bucket before that gap is closed risks the model *inferring* an answer for
  an unpublished policy question rather than escalating it — which is exactly
  the failure mode `question_terms` exists to prevent. Gate: don't ship Policy
  Assistant answers for any topic that isn't traceable to an existing,
  reviewed, florist-facing article.
- **Cross-system leakage.** Keep `kind` as the single dispatch point it
  already is in `agentTurn.ts`; do not let any new shared helper make it
  possible for a recruiting-kind conversation to reach the new
  published-content lookup or vice versa.
- **Before shipping any bucket:** `cxAgentGuard.test.mjs` and
  `supportFacts.test.mjs` green with the new fixtures; `npx tsc --noEmit` and
  `npm test` clean in `dashboard/`; the new answers exercised against a real
  order in a browser (the existing `/testing` demo sandbox already has
  `accepted-awaiting-photo` and other presets that cover most of Order Coach's
  grounding needs); and `lib/lifecycle.ts` updated in the same change, per
  repo convention.

## Open questions / unknowns to resolve before implementation

- Is there an internal "how we expect florists to operate" document anywhere
  outside this repo (a partner handbook, onboarding call script, etc.) that
  should become the source for the Policy Assistant / working-methodology
  content? Not found in this codebase — if it exists elsewhere, it needs to be
  turned into reviewed, florist-facing copy (most naturally new help-centre
  articles) before the bot can safely draw on it.
- Exact naming for the new `SupportIntent` values (`app_howto` /
  `process_explain` / `troubleshoot_howto` used above are placeholders) —
  pick these when writing the real design doc, informed by how cleanly they
  map onto the existing help-centre categories.
- Whether Troubleshooter needs anything beyond published content at all, or
  whether — as this doc argues — it's fully covered by App Guide content
  answered in response to "why won't X work" phrasing rather than "how do I
  X" phrasing.
- Florist Success Coach's product shape (proactive vs. reactive, what data it
  would need, who signs off on the tone of "you're underperforming" messaging
  to a small business) is undefined and deliberately not scoped here.
