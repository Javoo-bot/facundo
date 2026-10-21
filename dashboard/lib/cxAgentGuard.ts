// Whether an AI-written reply may be sent to a florist unread by a human.
//
// Pure, alias-free, unit-tested. This is the file that decides whether a model
// gets to talk to a stranger on our behalf, so it is deliberately boring,
// deterministic, and independent of the model's own opinion about itself.
//
// WHAT ACTUALLY MAKES THIS SAFE, in order:
//   1. CATEGORY escalation. High-risk intents — complaints, opt-outs, live
//      order problems/changes, florist-specific terms, unclear asks, or a
//      request for a person — are escalated before generated text is examined.
//      General published policy/how-to questions are a separate safe intent;
//      recognising that boundary is more reliable than vetting the answer.
//   2. The TURN CAP. After N unattended replies a human takes over regardless
//      of confidence. This bounds how far a conversation can drift.
//
// The text checks below are BACKSTOPS, not the safety story. Detecting a
// promise or an invented price by pattern across six languages is weak, and
// pretending otherwise would be the mistake. They are cheap, they catch the
// obvious cases, and they must never be the only thing standing between a
// model and a prospect.

export type AgentIntent =
  | "interested"
  | "question_logistics"
  | "question_pricing"
  | "question_legal"
  | "complaint"
  | "opt_out"
  | "wants_human"
  /** They asked whether they are talking to a person. This is ANSWERED, never
   * escalated — see the note on ESCALATE_INTENTS. */
  | "asked_if_ai"
  | "not_now"
  | "unclear";

/** What a JOINED florist writes in about. A different conversation from the one
 * above, so a different taxonomy — and the difference is load-bearing.
 *
 * `question_pricing` escalates for a prospect because any answer about money is
 * an offer we would be making. For a florist already in the network, "where is
 * my 30%?" is not an offer: it is a question with one true answer that we can
 * read out of the payouts table. Reusing the recruiting taxonomy here would
 * escalate the single most common support question there is, and the feature
 * would do nothing.
 *
 * The line drawn below is OUR OWN RECORDS vs ANYTHING ELSE. What we already
 * paid, what state their order is in, what we need from them next: answerable.
 * What we would pay in future, what the terms are, what went wrong, what should
 * change: a person. */
export type SupportIntent =
  /** Where is my order, what stage is it at, when is it due. */
  | "order_status"
  /** What have I been paid, when, why is a leg held. */
  | "payout_status"
  /** How do I upload the photo, what does it need to show. */
  | "photo_help"
  /** A general "what happens next / what stage is this order at" question,
   * answered from this order's own facts — not a change. New
   * 2026-08-15 (Order Coach); see
   * docs/superpowers/specs/2026-08-15-florist-operations-assistant-scope-design.md. */
  | "process_explain"
  /** How to use the app, or a general, published Facundo policy question
   * that is the same for every florist — getting paid, the card, the
   * substitution rule, whether the payout method can change. New 2026-08-15
   * (App Guide / Policy Assistant / procedural Troubleshooter). Never for a
   * live decision or problem on a real order — that stays delivery_problem /
   * change_request, unchanged. */
  | "app_howto"
  /** Something is wrong with the order — wrong address, missing flower, the
   * recipient is out. Escalates: this needs an order_issue, and an issue is the
   * thing that moves money. The agent may point at the button; it may not press
   * it. */
  | "delivery_problem"
  /** Asking us to change something — the date, the price, the assignment. */
  | "change_request"
  /** Commission, contracts, invoicing, tax, data. */
  | "question_terms"
  | "complaint"
  | "opt_out"
  | "wants_human"
  | "asked_if_ai"
  | "unclear";

export type AnyIntent = AgentIntent | SupportIntent;

/** Support intents a human must handle, before the reply text is read.
 *
 * Originally held all seven non-answerable intents (delivery_problem,
 * change_request, question_terms, complaint, wants_human, opt_out, unclear),
 * then emptied on request (2026-08-12) so support replies send themselves —
 * in practice most turns were the agent answering well and nothing going out.
 *
 * Restored for four of the seven ahead of the production pilot (2026-08-15).
 * These are the intents where a wrong or merely-adequate automated answer is
 * itself the failure, independent of how the model scored its own confidence:
 *
 *   - complaint, wants_human — the florist has already decided a human should
 *     be reading this. Answering well is not the same as being who they asked
 *     for, and cxAgent's prompt has no guidance string telling the model when
 *     to use either label (see INTENT_GUIDANCE in cxAgent.ts), so there is no
 *     self-escalation instruction to fall back on for these two.
 *   - delivery_problem — something is wrong with a real order in flight. Only
 *     an order_issue moves money, so a fluent reply that reads as "handled"
 *     is worse than a slower one from a person.
 *   - opt_out — a request to stop contacting them at all. The inbound
 *     email/SMS webhook path (lib/inboundIntent.ts::classifyInbound, wired in
 *     lib/conversations.ts) already catches this deterministically by keyword
 *     BEFORE any model runs, and that path is unaffected by this list. But the
 *     in-app order-chat path (lib/supportThread.ts) calls runAgentTurn
 *     directly with no such keyword gate, so for that surface this category
 *     rule is the only thing standing between "please stop messaging me" and
 *     a model-authored reply. Recording the opt-out itself (the
 *     order_emails_opt_out / order_sms_opt_out columns, stopAllForFlorist)
 *     stays a human action once escalated — this list does not add an
 *     auto-confirm path, it removes an auto-SEND path.
 *
 * change_request, question_terms and unclear joined the same day (2026-08-15):
 * self-reported confidence/escalate is not trusted for money (change_request
 * touches the assignment/price), legal (question_terms) or low-signal
 * (unclear) categories either — cxAgent's prompt instructs the model to
 * self-escalate the first two and unclear carries low confidence "by
 * definition", but both are the model's own opinion about itself, which is
 * exactly what category escalation exists to not depend on.
 *
 * What else still stops a reply, on every intent including these seven:
 *
 *   - a figure that is not in this order's facts (moneyClaimOutsideFacts)
 *   - a promise (containsPromise)
 *   - the model's own escalate flag, and confidence below the floor
 *   - the unattended-turn cap
 *   - "are you a bot?" answered without the admission
 *   - an order with an open issue (ctx.openIssue), which wins even over the
 *     asked_if_ai disclosure exemption — see escalationDecision
 *
 * The recruiting list above was never emptied and must not be: there, money is
 * an offer we would be making to someone who has not joined.
 *
 * Two answerable intents, `process_explain` and `app_howto`, joined the SAFE
 * side of the taxonomy the same day (2026-08-15) — general, published process
 * explanation and policy/how-to content, sourced from
 * lib/support/publishedHelp.ts, never a live change or problem on a real
 * order. They are deliberately NOT added below. */
export const SUPPORT_ESCALATE_INTENTS: readonly SupportIntent[] = [
  "complaint",
  "wants_human",
  "delivery_problem",
  "opt_out",
  "change_request",
  "question_terms",
  "unclear",
];

/** Intents that are ALWAYS a human's job, decided before the reply text is
 * looked at. Money, contracts and complaints are where an automated answer is
 * most likely to be both wrong and quoted back at us.
 *
 * `asked_if_ai` is deliberately NOT here. Escalating "are you a real person?"
 * means the florist gets silence and then a human — which is evasive, and fails
 * the disclosure obligation precisely when it is being invoked. The question has
 * one correct answer and the agent gives it, guarded by
 * `replyDisclosesAi` below so the model cannot improvise around it. */
export const ESCALATE_INTENTS: readonly AgentIntent[] = [
  "question_pricing",
  "question_legal",
  "complaint",
  "wants_human",
  "opt_out",
];

export interface AgentJudgment {
  intent: AnyIntent;
  replyText: string;
  confidence: number;
  /** The model's own opinion. Considered, never trusted alone. */
  escalate?: boolean;
  /** Every factual claim the reply makes, as the model itself lists them. */
  factsAsserted?: string[];
}

export interface GuardContext {
  autoTurns: number;
  maxAutoTurns: number;
  minConfidence: number;
  /** False for a shop that has opted out, been excluded, or has an open order
   * issue — an order problem is never a recruiting conversation. */
  eligible?: boolean;
  /** Support-only. True when the florist behind this conversation has a real
   * order/assignment here but `joined_at` is unset — see `not_joined` above.
   * Checked separately from `eligible` so an excluded shop (which IS
   * ineligible) is never confused with a live, not-yet-joined lead (which is
   * not). */
  notJoinedYet?: boolean;
  /** Which taxonomy the intent belongs to, and therefore which intents are a
   * human's job. Defaults to recruiting so every existing call site keeps its
   * behaviour without being edited. */
  kind?: "recruiting" | "support";
  /** The exact figures lib/supportFacts.ts read out of the database for THIS
   * conversation. Empty (the default) means the reply may state no money at
   * all — the recruiting rule. */
  allowedAmounts?: readonly number[];
  /** True when lib/supportFacts.ts found an order_issue already open on this
   * order (SupportFacts.hasOpenIssue). A human is already involved, so the
   * agent must not send anything at all — not even the asked_if_ai disclosure
   * — regardless of intent, confidence, or the model's own escalate flag. */
  openIssue?: boolean;
}

export type EscalationReason =
  | "model_flagged"
  | "intent"
  | "low_confidence"
  | "turn_cap"
  | "money_claim"
  | "promise"
  | "not_eligible"
  /** Support-only: this shop is NOT excluded and IS the kind of shop this
   * assistant serves — it has a real order attached to this conversation —
   * it just hasn't finished joining yet (a cold offer, or a staff manual
   * override, accepted before the usual activation step ran). Kept distinct
   * from `not_eligible` because that label reads as "exclude this shop",
   * which is the opposite of what CX should do with a live lead. */
  | "not_joined"
  | "empty_reply"
  /** Asked whether we are AI, and the drafted answer did not say so. */
  | "evaded_disclosure"
  /** ctx.openIssue: a human is already handling a reported problem on this
   * order. Wins over every other rule, including the disclosure exemption. */
  | "open_issue";

export type GuardDecision =
  | { action: "send" }
  | { action: "escalate"; reason: EscalationReason };

// Percentages that are the offer itself, so they need no per-conversation
// grounding. Deliberately NOT extended to currency amounts: "100 EUR" is a
// claim about money we would pay, "100%" is a description of the split.
const ALLOWED_PERCENTAGES = new Set([70, 30, 100]);

const CURRENCY = String.raw`[€$£¥]|\b(?:eur|usd|gbp|euros?|dollars?|pounds?)\b`;
// A number attached to a currency marker, either side of it. Both orders occur
// in the six markets we write to ("€84.50", "84,50 EUR").
const MONEY_PAIR = new RegExp(String.raw`(?:${CURRENCY})\s*([\d][\d.,\s]*\d|\d)|([\d][\d.,\s]*\d|\d)\s*(?:${CURRENCY})`, "gi");
const CURRENCY_ANYWHERE = new RegExp(CURRENCY, "i");

/**
 * Read a written amount as a number, across the decimal conventions of the six
 * markets. Returns null when it cannot be read, which callers treat as a
 * FAILURE to verify rather than a pass.
 *
 *   "84.50" "84,50" "84,5" → 84.5      "1,234.56" "1.234,56" → 1234.56
 *
 * The rule: when both separators appear, the rightmost is the decimal point.
 * When only one appears, it is a decimal point only if one or two digits
 * follow it — "1,234" is a thousand, "84,50" is eighty-four fifty.
 */
export function parseAmount(raw: string): number | null {
  const s = String(raw ?? "").replace(/[^\d.,]/g, "");
  if (!s || !/\d/.test(s)) return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let normalised: string;

  if (lastDot >= 0 && lastComma >= 0) {
    const decimalAt = Math.max(lastDot, lastComma);
    const thousands = decimalAt === lastDot ? "," : ".";
    normalised = s.split(thousands).join("");
    normalised = normalised.replace(decimalAt === lastDot ? /,/g : /\./g, ".");
    // Re-point: after stripping the thousands separator only the decimal one is
    // left, whichever character it was.
    normalised = normalised.replace(",", ".");
  } else if (lastComma >= 0) {
    normalised = /,\d{1,2}$/.test(s) ? s.replace(",", ".") : s.split(",").join("");
  } else if (lastDot >= 0) {
    normalised = /\.\d{1,2}$/.test(s) ? s : s.split(".").join("");
  } else {
    normalised = s;
  }

  const n = Number.parseFloat(normalised);
  return Number.isFinite(n) ? n : null;
}

/** Cents, so 84.5 and 84.50 are the same fact and 84.51 is not. */
const cents = (n: number): number => Math.round(n * 100);

/**
 * Does this reply state a money figure we did not give it?
 *
 * THE CHANGE THAT MADE THE SUPPORT AGENT POSSIBLE, and the riskiest edit in the
 * feature, so it is worth being precise about what did and did not change.
 *
 * This used to refuse ANY currency symbol outright. That is correct for a
 * prospect — every number is an offer — but it makes it impossible to answer
 * "how much did you pay me?", which is most of what a joined florist asks.
 *
 * What replaced it is NOT a relaxation. It is the same rule with a different
 * source for the allow-list: instead of a hardcoded constant, the caller passes
 * the exact amounts lib/supportFacts.ts read out of the payouts table for THIS
 * conversation. A figure in that set may be repeated; anything else escalates,
 * exactly as before. The model still cannot produce a number — it can only
 * hand back one we handed it.
 *
 * `allowed` empty reproduces the old behaviour byte for byte, which is what the
 * recruiting agent passes and what its regression test asserts.
 */
export function moneyClaimOutsideFacts(text: string, allowed: readonly number[] = []): boolean {
  const allowedCents = new Set(allowed.filter((n) => Number.isFinite(n)).map(cents));

  // Currency amounts. Each pair is checked and then blanked, so whatever
  // currency markers remain afterwards had no readable number attached.
  let remaining = text;
  for (const m of text.matchAll(MONEY_PAIR)) {
    const amount = parseAmount(m[1] ?? m[2] ?? "");
    if (amount === null || !allowedCents.has(cents(amount))) return true;
    remaining = remaining.replace(m[0], " ");
  }
  // A currency word with nothing verifiable next to it ("we'll sort the euros
  // out next week"). Unverifiable is refused, not waved through.
  if (CURRENCY_ANYWHERE.test(remaining)) return true;

  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)) {
    const pct = parseAmount(m[1]);
    if (pct === null) return true;
    if (!ALLOWED_PERCENTAGES.has(pct) && !allowedCents.has(cents(pct))) return true;
  }

  return false;
}

/** The recruiting-era check, preserved as the zero-facts case of the above.
 * Kept as its own name because that is what reads correctly at the call sites
 * where no facts exist to allow. */
export function containsMoneyClaim(text: string): boolean {
  return moneyClaimOutsideFacts(text, []);
}

// Phrases that commit us to something we cannot guarantee — an order, a date, a
// volume. Per-locale and knowingly incomplete; see the header.
const PROMISE_PATTERNS: RegExp[] = [
  /\bwe(?:'| wi)ll (?:send|give|guarantee|have) you\b/i,
  /\byou(?:'| wi)ll (?:get|receive|have)\b.{0,30}\b(order|orders)\b/i,
  /\bguarantee\b/i,
  /\bte (?:enviaremos|garantizamos|daremos)\b/i,
  /\bgarantizamos\b/i,
  /\bnous vous (?:enverrons|garantissons)\b/i,
  /\bgarantissons\b/i,
  /\bti (?:invieremo|garantiamo)\b/i,
  /\bgarantiamo\b/i,
  /\bwir (?:schicken|garantieren) (?:dir|Ihnen)\b/i,
  /\bgarantieren\b/i,
  /\b(?:enviaremos|garantimos)\b/i,
];

export function containsPromise(text: string): boolean {
  return PROMISE_PATTERNS.some((re) => re.test(text));
}

/** Words that constitute admitting to being software, in the six markets.
 * Matched loosely on purpose — the requirement is that the reply SAYS SO, not
 * that it says so in one exact phrasing. */
const DISCLOSURE_TERMS = [
  "automated", "automatic", "ai ", "a.i.", "artificial intelligence", "bot", "assistant", "software",
  "automatizad", "automatico", "automático", "inteligencia artificial", "asistente",
  "automatis", "automatique", "intelligence artificielle", "assistant",
  "automatizzat", "automatico", "intelligenza artificiale", "assistente",
  "automatisiert", "automatisch", "kuenstliche intelligenz", "künstliche intelligenz", "assistent",
  "automatizad", "automático", "inteligência artificial", "assistente",
];

/** Does this reply actually admit to being an automated system?
 *
 * Deliberately generous about phrasing and strict about presence. The failure
 * this guards against is not an inelegant disclosure — it is a fluent,
 * confident non-answer to "am I talking to a person?", which is the single
 * worst thing this agent could send. */
export function replyDisclosesAi(text: string): boolean {
  const t = text.toLowerCase();
  return DISCLOSURE_TERMS.some((w) => t.includes(w));
}

/**
 * May this reply go out unread?
 *
 * Returns the reason on refusal so CX sees WHY a draft is waiting rather than
 * an unexplained queue.
 */
export function escalationDecision(j: AgentJudgment, ctx: GuardContext): GuardDecision {
  if (ctx.eligible === false) return { action: "escalate", reason: "not_eligible" };
  if (ctx.notJoinedYet) return { action: "escalate", reason: "not_joined" };

  // An empty or whitespace reply is not a reply. Sending one would be worse
  // than silence, and it usually means the model failed rather than declined.
  if (!j.replyText || j.replyText.trim().length === 0) {
    return { action: "escalate", reason: "empty_reply" };
  }

  // A human is already handling a reported problem on this order. This wins
  // over everything below, including the asked_if_ai disclosure exemption:
  // "are you a bot?" still deserves an answer, but not one that talks over a
  // colleague who is already on the thread.
  if (ctx.openIssue) return { action: "escalate", reason: "open_issue" };

  // Category first, before the text is examined at all.
  const escalateIntents: readonly string[] =
    ctx.kind === "support" ? SUPPORT_ESCALATE_INTENTS : ESCALATE_INTENTS;
  if (escalateIntents.includes(j.intent)) return { action: "escalate", reason: "intent" };

  // Asked outright. The answer must contain the admission; a fluent non-answer
  // to "are you a person?" is the worst thing this agent could send, so a reply
  // that dodges goes to a human instead of going out.
  if (j.intent === "asked_if_ai" && !replyDisclosesAi(j.replyText)) {
    return { action: "escalate", reason: "evaded_disclosure" };
  }

  // THE ONE EXEMPTION from the turn cap and the confidence floor.
  //
  // Every other guard here exists to stop the model drifting. This answer
  // cannot drift: it is one approved sentence, and it has already been checked
  // to contain the admission. Meanwhile escalating it produces exactly the
  // outcome the disclosure rule exists to prevent — a florist asks "am I
  // talking to a person?" and gets silence until a human gets round to it.
  //
  // The text backstops below still apply, so this cannot be used to smuggle a
  // price or a promise out under cover of the disclosure.
  const disclosing = j.intent === "asked_if_ai";

  if (!disclosing) {
    // The ceiling. Checked before confidence so a run of confident replies can
    // never talk its way past it.
    if (ctx.autoTurns >= ctx.maxAutoTurns) return { action: "escalate", reason: "turn_cap" };

    if (j.escalate === true) return { action: "escalate", reason: "model_flagged" };

    if (!Number.isFinite(j.confidence) || j.confidence < ctx.minConfidence) {
      return { action: "escalate", reason: "low_confidence" };
    }
  }

  // Backstops. Applied to every reply, disclosure included.
  //
  // NOT GUARDED HERE, and worth saying out loud: dates. A support reply may
  // state a delivery date, and there is no reliable way to allow-list one by
  // pattern across six languages of month names. The protection for a wrong
  // date is the fact list itself, the confidence floor, and the fact that the
  // florist can see the real date in the app on the same screen. A wrong date
  // is a nuisance; a wrong figure is a payment dispute, which is why only the
  // figure gets a hard gate.
  const allowed = ctx.allowedAmounts ?? [];
  if (moneyClaimOutsideFacts(j.replyText, allowed)) return { action: "escalate", reason: "money_claim" };
  if (containsPromise(j.replyText)) return { action: "escalate", reason: "promise" };
  if ((j.factsAsserted ?? []).some((f) => moneyClaimOutsideFacts(f, allowed) || containsPromise(f))) {
    return { action: "escalate", reason: "money_claim" };
  }

  return { action: "send" };
}


/** Is this the LLM account being unavailable — no credit, bad key, over a
 * limit — rather than this one reply going wrong?
 *
 * Mirrors ingest-worker/src/openrouter.ts::isLlmOutage, which draws the same
 * line for the ingest pipeline. Matched on the status lib/cxAgent.ts puts at
 * the front of the message, because there is no error type to branch on here.
 *
 * Every one of these is a deployment or billing fault that will fail the next
 * conversation identically, and none of them is worth a florist wondering why
 * nobody answered. */
export function llmUnavailable(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  if (/OpenRouter (401|402|403|429)\b/.test(message)) return true;
  return /credit balance is too low|insufficient credit|limit exceeded|quota exceeded/i.test(message);
}
