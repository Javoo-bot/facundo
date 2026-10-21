import test from "node:test";
import assert from "node:assert/strict";
import {
  escalationDecision,
  containsMoneyClaim,
  containsPromise,
  replyDisclosesAi,
  ESCALATE_INTENTS,
  SUPPORT_ESCALATE_INTENTS,
  moneyClaimOutsideFacts,
  parseAmount,
} from "./cxAgentGuard.ts";

const CTX = { autoTurns: 0, maxAutoTurns: 3, minConfidence: 0.75, eligible: true };
const J = (over = {}) => ({
  intent: "question_logistics",
  replyText: "Yes, you can decline any order that doesn't suit you. Just tap Decline.",
  confidence: 0.9,
  escalate: false,
  factsAsserted: [],
  ...over,
});

test("a clean, confident logistics answer sends", () => {
  assert.deepEqual(escalationDecision(J(), CTX), { action: "send" });
});

// Category escalation is the primary safety story: recognising the QUESTION is
// far more reliable than vetting the answer.
test("every money/legal/complaint/human intent escalates, however confident", () => {
  for (const intent of ESCALATE_INTENTS) {
    const d = escalationDecision(J({ intent, confidence: 1 }), CTX);
    assert.equal(d.action, "escalate", intent);
    assert.equal(d.reason, "intent", intent);
  }
});

// The guard I'd actually defend: a hard ceiling, checked before confidence so a
// run of confident replies can't talk its way past it.
test("the turn cap holds regardless of confidence", () => {
  const d = escalationDecision(J({ confidence: 1 }), { ...CTX, autoTurns: 3 });
  assert.equal(d.action, "escalate");
  assert.equal(d.reason, "turn_cap");
  assert.equal(escalationDecision(J(), { ...CTX, autoTurns: 2 }).action, "send");
});

test("low confidence escalates; the threshold is inclusive", () => {
  assert.equal(escalationDecision(J({ confidence: 0.74 }), CTX).reason, "low_confidence");
  assert.equal(escalationDecision(J({ confidence: 0.75 }), CTX).action, "send");
  for (const c of [Number.NaN, undefined, null, "high"]) {
    assert.equal(escalationDecision(J({ confidence: c }), CTX).reason, "low_confidence", String(c));
  }
});

test("the model's own flag is honoured even when everything else passes", () => {
  assert.equal(escalationDecision(J({ escalate: true }), CTX).reason, "model_flagged");
});

test("an ineligible florist is never answered automatically", () => {
  assert.equal(escalationDecision(J(), { ...CTX, eligible: false }).reason, "not_eligible");
});

test("an empty reply escalates rather than sending silence", () => {
  for (const t of ["", "   ", "\n\t"]) {
    assert.equal(escalationDecision(J({ replyText: t }), CTX).reason, "empty_reply", JSON.stringify(t));
  }
});

// ---- backstops ----

test("an invented commission or currency figure is caught", () => {
  for (const t of [
    "Our commission is 15%.",
    "We charge €20 per order.",
    "That'll be 25 EUR.",
    "It costs $30.",
    "A fee of 12.5% applies.",
    "We take 10 pounds.",
  ]) {
    assert.ok(containsMoneyClaim(t), `missed: ${t}`);
  }
});

// The 70/30 split IS the offer — the agent has to be able to restate it.
test("the approved 70/30 split is not treated as an invented figure", () => {
  for (const t of [
    "We pay 70% when you accept and 30% before you deliver.",
    "You get 70 % up front.",
    "100% of the bouquet is yours to make.",
  ]) {
    assert.ok(!containsMoneyClaim(t), `false positive: ${t}`);
  }
  assert.equal(escalationDecision(J({ replyText: "We pay 70% on accept, 30% before delivery." }), CTX).action, "send");
});

test("a promise of orders is caught in each market's language", () => {
  for (const t of [
    "We'll send you an order next week.",
    "You'll get orders every month.",
    "I guarantee it.",
    "Te enviaremos un pedido pronto.",
    "Nous vous enverrons une commande.",
    "Ti invieremo un ordine.",
    "Wir schicken dir eine Bestellung.",
  ]) {
    assert.ok(containsPromise(t), `missed: ${t}`);
  }
});

test("ordinary helpful copy is not mistaken for a promise", () => {
  for (const t of [
    "You decide on each order, one at a time.",
    "Orders come by email or text when one lands near you.",
    "There is no minimum and no contract.",
  ]) {
    assert.ok(!containsPromise(t), `false positive: ${t}`);
  }
});

test("a claim hidden in facts_asserted is caught even when the prose is clean", () => {
  const d = escalationDecision(
    J({ replyText: "That all sounds fine, happy to help.", factsAsserted: ["our commission is 15%"] }),
    CTX
  );
  assert.equal(d.action, "escalate");
  assert.equal(d.reason, "money_claim");
});

// Ordering matters: a category escalation must win over a text-level one, so
// CX sees the real reason rather than a symptom.
test("intent escalation is reported ahead of the text backstops", () => {
  const d = escalationDecision(J({ intent: "question_pricing", replyText: "We charge €20." }), CTX);
  assert.equal(d.reason, "intent");
});

// ---- disclosure ----
// EU AI Act Art. 50 applies from 2 Aug 2026 in every market this funnel targets.
// The persona actively points the reader away from "this is a machine", which is
// exactly what removes the "obvious from context" exemption.

test("asked_if_ai is ANSWERED, not escalated — silence is the evasive option", () => {
  const d = escalationDecision(
    J({ intent: "asked_if_ai", replyText: "No, I'm an automated assistant. I can put you through to a colleague." }),
    CTX
  );
  assert.deepEqual(d, { action: "send" });
});

test("a fluent non-answer to 'are you a person?' never goes out", () => {
  for (const dodge of [
    "I'm here to help with anything you need!",
    "Happy to answer any questions about how it works.",
    "That's a great question — what else can I help with?",
  ]) {
    const d = escalationDecision(J({ intent: "asked_if_ai", replyText: dodge }), CTX);
    assert.equal(d.action, "escalate", dodge);
    assert.equal(d.reason, "evaded_disclosure", dodge);
  }
});

test("the admission is recognised in every market's language", () => {
  for (const reply of [
    "I'm an automated assistant, not a person.",
    "Soy un asistente automatizado.",
    "Je suis un assistant automatique.",
    "Sono un assistente automatico.",
    "Ich bin ein automatisierter Assistent.",
    "Sou um assistente automático.",
  ]) {
    assert.ok(replyDisclosesAi(reply), `not recognised as a disclosure: ${reply}`);
  }
});

test("disclosure is checked before the turn cap, so the question is always answered", () => {
  // Otherwise the one question we are obliged to answer would be the one that
  // silently hits the ceiling and goes to a human instead.
  const d = escalationDecision(
    J({ intent: "asked_if_ai", replyText: "Yes — I'm an automated assistant." }),
    { ...CTX, autoTurns: 99 }
  );
  assert.deepEqual(d, { action: "send" });
});

test("asking if we're AI still can't smuggle a money claim past the guard", () => {
  const d = escalationDecision(
    J({ intent: "asked_if_ai", replyText: "I'm an automated assistant. Our commission is 15%." }),
    CTX
  );
  assert.equal(d.action, "escalate");
  assert.equal(d.reason, "money_claim");
});

// ---------------------------------------------------------------------------
// Support conversations: the same guard, with a per-conversation allow-list.
// ---------------------------------------------------------------------------

const SUPPORT = { ...CTX, kind: "support", allowedAmounts: [84.5, 36.21] };
const S = (over = {}) => J({ intent: "payout_status", ...over });

test("REGRESSION: with no facts, the money check is the old one exactly", () => {
  // The safety claim the whole change rests on: every recruiting conversation
  // must behave the same after the support agent shipped as before it.
  //
  // The expectations below are written out by hand from the ORIGINAL
  // implementation — "any currency symbol or code at all, plus any percentage
  // outside 70/30/100". Asserting against containsMoneyClaim() instead would
  // prove nothing, because that is now a wrapper around the function under
  // test.
  const cases = [
    ["Our commission is 15%.", true],
    ["We take €5 per order.", true],
    ["That's 20 EUR.", true],
    ["It costs 100 dollars.", true],
    ["£12.50 per delivery.", true],
    ["we'll sort the euros out next week", true],
    ["We pay 70% up front and 30% on the photo.", false],
    ["You keep 100% of it.", false],
    ["No fee at all.", false],
    ["Just tap Decline if it doesn't suit you.", false],
  ];
  for (const [text, expected] of cases) {
    assert.equal(moneyClaimOutsideFacts(text, []), expected, `wrong verdict for: ${text}`);
    // And the named wrapper the recruiting call sites use agrees.
    assert.equal(containsMoneyClaim(text), expected, `wrapper diverged for: ${text}`);
  }
});

test("a figure we looked up may be repeated", () => {
  const d = escalationDecision(
    S({ replyText: "We sent €84.50 to your card when you accepted." }),
    SUPPORT
  );
  assert.deepEqual(d, { action: "send" });
});

test("the same figure one cent out escalates", () => {
  // The property that makes this an allow-list rather than a relaxation: near
  // enough is not a fact.
  for (const wrong of ["€84.51", "€84.40", "€85", "€8.45", "€845.00"]) {
    const d = escalationDecision(S({ replyText: `We sent ${wrong} to your card.` }), SUPPORT);
    assert.equal(d.action, "escalate", wrong);
    assert.equal(d.reason, "money_claim", wrong);
  }
});

test("a figure from some other florist's conversation escalates", () => {
  // allowedAmounts is built per conversation. A number that is real, but real
  // for someone else, is exactly as inventable as one that is real for nobody.
  const d = escalationDecision(S({ replyText: "We sent €120.00 to your card." }), SUPPORT);
  assert.equal(d.action, "escalate");
  assert.equal(d.reason, "money_claim");
});

test("the allow-list is matched on value, not on spelling", () => {
  // The six markets write the same amount five ways. All of them are the fact.
  for (const written of ["€84.50", "84,50 EUR", "84,5 euros", "€84.5", "84.50 EUR"]) {
    const d = escalationDecision(S({ replyText: `We sent ${written} to your card.` }), SUPPORT);
    assert.deepEqual(d, { action: "send" }, written);
  }
});

test("thousands separators are read, not stripped into a different number", () => {
  // "1.234,56" is twelve hundred, not 1.23456. Getting this wrong would let a
  // four-figure claim through against a four-figure fact that isn't the same.
  assert.equal(parseAmount("1.234,56"), 1234.56);
  assert.equal(parseAmount("1,234.56"), 1234.56);
  assert.equal(parseAmount("84,50"), 84.5);
  assert.equal(parseAmount("84.50"), 84.5);
  assert.equal(parseAmount("1,234"), 1234);
  assert.equal(parseAmount("1.234"), 1234);
  assert.equal(parseAmount("12"), 12);
  assert.equal(parseAmount("nonsense"), null);
  assert.equal(parseAmount(""), null);
});

test("an unreadable amount next to a currency marker is refused, not skipped", () => {
  assert.equal(moneyClaimOutsideFacts("we'll send the € across", [84.5]), true);
  assert.equal(moneyClaimOutsideFacts("a few hundred euros", [84.5]), true);
});

test("both payout legs can be stated in one reply", () => {
  const d = escalationDecision(
    S({ replyText: "€84.50 went out when you accepted, and €36.21 is waiting on the photo." }),
    SUPPORT
  );
  assert.deepEqual(d, { action: "send" });
});

test("one good figure does not license a second invented one", () => {
  const d = escalationDecision(
    S({ replyText: "€84.50 went out, and there's a €5 bonus on top." }),
    SUPPORT
  );
  assert.equal(d.action, "escalate");
  assert.equal(d.reason, "money_claim");
});

test("70 and 30 per cent stay sayable without being in the facts", () => {
  // They describe the split rather than claiming a payment, so they are not
  // per-conversation facts and must not need grounding.
  const d = escalationDecision(
    S({ replyText: "We pay 70% on acceptance and the other 30% once the photo is checked." }),
    { ...SUPPORT, allowedAmounts: [] }
  );
  assert.deepEqual(d, { action: "send" });
});

test("an invented percentage is still caught in a support thread", () => {
  const d = escalationDecision(S({ replyText: "You'll get an extra 15% on this one." }), SUPPORT);
  assert.equal(d.action, "escalate");
  assert.equal(d.reason, "money_claim");
});

test("support escalates what it must not decide, and answers what it can read", () => {
  for (const intent of SUPPORT_ESCALATE_INTENTS) {
    const d = escalationDecision(S({ intent, confidence: 1 }), SUPPORT);
    assert.equal(d.action, "escalate", intent);
    assert.equal(d.reason, "intent", intent);
  }
  for (const intent of ["order_status", "payout_status", "photo_help", "process_explain", "app_howto"]) {
    const d = escalationDecision(
      S({ intent, replyText: "Your order is out for delivery today." }),
      SUPPORT
    );
    assert.deepEqual(d, { action: "send" }, intent);
  }
  // asked_if_ai is answerable too, but only with a reply that actually
  // discloses AI-ness — see replyDisclosesAi and the dedicated tests below.
  const disclosed = escalationDecision(
    S({ intent: "asked_if_ai", replyText: "Yes, I'm an automated assistant." }),
    SUPPORT
  );
  assert.deepEqual(disclosed, { action: "send" });
});

test("all seven non-answerable support intents escalate on category alone, however confident", () => {
  // complaint/wants_human/delivery_problem/opt_out were restored ahead of the
  // production pilot (2026-08-15); change_request/question_terms/unclear
  // joined them the same day. Self-reported confidence/escalate is not
  // trusted for money (change_request touches the assignment/price), legal
  // (question_terms) or low-signal (unclear) categories either — see the doc
  // comment on SUPPORT_ESCALATE_INTENTS for the full reasoning.
  for (const intent of [
    "complaint",
    "wants_human",
    "delivery_problem",
    "opt_out",
    "change_request",
    "question_terms",
    "unclear",
  ]) {
    const d = escalationDecision(S({ intent, confidence: 1, escalate: false }), SUPPORT);
    assert.equal(d.action, "escalate", intent);
    assert.equal(d.reason, "intent", intent);
  }
  assert.deepEqual(
    [...SUPPORT_ESCALATE_INTENTS].sort(),
    ["change_request", "complaint", "delivery_problem", "opt_out", "question_terms", "unclear", "wants_human"].sort()
  );
});

test("emptying the support list did not touch the recruiting one", () => {
  // Different audience, different stakes: to a prospect, anything about money
  // is an offer we would be making. That list stays.
  assert.ok(ESCALATE_INTENTS.length > 0);
  for (const intent of ESCALATE_INTENTS) {
    assert.equal(escalationDecision(J({ intent, confidence: 1 }), CTX).action, "escalate", intent);
  }
});

test("backstops still stop safe support replies", () => {
  // Safe intents can auto-send only after the deterministic backstops clear.
  const money = escalationDecision(
    S({ intent: "payout_status", replyText: "We'll send you €900.00." }), SUPPORT);
  assert.equal(money.reason, "money_claim");
  const promise = escalationDecision(
    S({ intent: "order_status", replyText: "I guarantee it lands tomorrow." }), SUPPORT);
  assert.equal(promise.reason, "promise");
  assert.equal(escalationDecision(S({ confidence: 0.5 }), SUPPORT).reason, "low_confidence");
  assert.equal(escalationDecision(S({ escalate: true }), SUPPORT).reason, "model_flagged");
  assert.equal(escalationDecision(S(), { ...SUPPORT, autoTurns: 3 }).reason, "turn_cap");
  assert.equal(escalationDecision(S(), { ...SUPPORT, eligible: false }).reason, "not_eligible");
});

test("the two kinds still read different lists", () => {
  // payout_status is support-only and answerable — it reads our own payouts
  // table for a florist already in the network. question_pricing is
  // recruiting-only and always escalates — any money figure quoted to a
  // prospect is an offer we would be making. That difference is the reason
  // `kind` exists.
  assert.equal(escalationDecision(J({ intent: "question_pricing" }), CTX).reason, "intent");
  assert.deepEqual(
    escalationDecision(S({ intent: "payout_status", replyText: "We sent €84.50 to your card." }), SUPPORT),
    { action: "send" }
  );
});

test("process_explain and app_howto are not in the support escalate list", () => {
  assert.ok(!SUPPORT_ESCALATE_INTENTS.includes("process_explain"));
  assert.ok(!SUPPORT_ESCALATE_INTENTS.includes("app_howto"));
});

// The adversarial pair the scope doc flags as the actual risk surface: the
// SAME topic (flower substitution), one general and answerable, one a live
// decision on a real order that must still escalate on intent alone.
test("a live substitution decision on a real order escalates even though the general rule is answerable", () => {
  const d = escalationDecision(
    S({ intent: "delivery_problem", confidence: 1, replyText: "I'm out of roses for this order, can I use something else?" }),
    SUPPORT
  );
  assert.equal(d.action, "escalate");
  assert.equal(d.reason, "intent");
});

test("the same general substitution-rule wording sends under app_howto", () => {
  const d = escalationDecision(
    S({ intent: "app_howto", replyText: "You may swap a flower, never a rose, for one similar in shape and colour, or that doesn't change the bouquet's character, up to 30% of it. Report it through Report a problem." }),
    SUPPORT
  );
  assert.deepEqual(d, { action: "send" });
});

test("backstops still apply to the new intents — an invented figure under app_howto escalates", () => {
  const d = escalationDecision(
    S({ intent: "app_howto", replyText: "The card also comes with a €5 monthly fee." }),
    SUPPORT
  );
  assert.equal(d.action, "escalate");
  assert.equal(d.reason, "money_claim");
});

test("the turn cap and confidence floor are unchanged by grounding", () => {
  // Grounding says what may be REPEATED. It says nothing about how long a model
  // may run unattended, and must not be able to buy extra turns.
  assert.equal(escalationDecision(S(), { ...SUPPORT, autoTurns: 3 }).reason, "turn_cap");
  assert.equal(escalationDecision(S({ confidence: 0.5 }), SUPPORT).reason, "low_confidence");
});

// ---------------------------------------------------------------------------
// Open issues: deterministic handover, not a prompt sentence.
// ---------------------------------------------------------------------------

test("an open issue escalates unconditionally, regardless of intent, confidence or the model's own flag", () => {
  for (const intent of ["order_status", "payout_status"]) {
    const d = escalationDecision(
      S({ intent, confidence: 1, escalate: false, replyText: "Your order is on its way." }),
      { ...SUPPORT, openIssue: true }
    );
    assert.equal(d.action, "escalate", intent);
    assert.equal(d.reason, "open_issue", intent);
  }
});

test("an open issue wins even over the asked_if_ai disclosure exemption", () => {
  // Deliberate and conservative for this pilot: an order with an open issue
  // gets NO unattended reply at all, not even the one sentence answering
  // "are you a bot?".
  const d = escalationDecision(
    S({ intent: "asked_if_ai", replyText: "Yes, I'm an automated assistant." }),
    { ...SUPPORT, openIssue: true }
  );
  assert.equal(d.action, "escalate");
  assert.equal(d.reason, "open_issue");
});

test("no open issue behaves exactly as before", () => {
  assert.deepEqual(escalationDecision(S(), { ...SUPPORT, openIssue: false }), { action: "send" });
  assert.deepEqual(escalationDecision(S(), SUPPORT), { action: "send" });
});

// A florist with a real, assigned order (a cold offer, or a staff manual
// override) who hasn't finished joining yet is NOT excluded and NOT the wrong
// kind of shop for support — it still needs a human, but "not_eligible"'s
// label ("This shop is excluded, or is not the kind of shop this assistant
// serves") is false on both counts and misleads whoever reads the queue.
test("a florist with a real order who hasn't finished joining gets an accurate reason, not the exclusion label", () => {
  const d = escalationDecision(S(), { ...SUPPORT, eligible: true, notJoinedYet: true });
  assert.equal(d.action, "escalate");
  assert.equal(d.reason, "not_joined");
});

test("excluded still wins over not-yet-joined when somehow both are true", () => {
  const d = escalationDecision(S(), { ...SUPPORT, eligible: false, notJoinedYet: true });
  assert.equal(d.reason, "not_eligible");
});
