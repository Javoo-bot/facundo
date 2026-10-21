// The fact list the support agent is grounded on. Run with:
//   node --test lib/supportFacts.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { buildSupportFacts } from "./supportFacts.ts";
import { moneyClaimOutsideFacts } from "./cxAgentGuard.ts";

const base = {
  order: {
    order_name: "#1042",
    delivery_at: "2026-08-14T09:00:00Z",
    delivery_window: "10:00–14:00",
    status: "assigned",
  },
  assignment: { status: "accepted", accepted_at: "2026-08-11T08:30:00Z", delivered_at: null },
  payouts: [
    { leg: "accept", amount: 84.5, currency: "EUR", status: "issued" },
    { leg: "delivery", amount: 36.21, currency: "EUR", status: "pending" },
  ],
  photoVerdict: null,
  openIssues: 0,
};

const text = (f) => f.lines.join("\n");

test("the amounts in the lines are exactly the amounts on the allow-list", () => {
  // THE INVARIANT THE WHOLE DESIGN RESTS ON. If a sentence can contain a figure
  // that is not in allowedAmounts, the guard escalates a reply that only
  // repeated what we told it — and the agent becomes useless in the exact case
  // it exists for. If the reverse can happen, the allow-list authorises a
  // number the model was never shown, which is worse.
  const f = buildSupportFacts(base);
  assert.deepEqual([...f.allowedAmounts].sort(), [36.21, 84.5]);
  // Proved through the guard itself rather than by re-reading the strings:
  // every fact line must survive the check it will be graded against.
  for (const line of f.lines) {
    assert.equal(moneyClaimOutsideFacts(line, f.allowedAmounts), false, line);
  }
});

test("a paid leg says the money is gone, a pending one says why not", () => {
  const f = buildSupportFacts(base);
  assert.match(text(f), /84\.50 EUR, and it has been sent to the florist's card/);
  assert.match(text(f), /36\.21 EUR\. It has not been sent yet because we have not had the delivery photo/);
});

test("a held delivery leg says nothing is needed, without blaming the photo", () => {
  // "Held" with no reason is the sentence that makes a florist write in twice —
  // but as of 2026-08-20 a `review`/`fail` photo verdict is no longer WHY a
  // leg holds (see lib/payoutHold.ts), so a held row can no longer be
  // attributed to the photo check here: the actual reason (tier-hold,
  // provisional-shop, or the operator's delivery-gate switch) is independent
  // of `photoVerdict`, and naming the photo would often just be wrong.
  const f = buildSupportFacts({
    ...base,
    payouts: [
      { leg: "accept", amount: 84.5, currency: "EUR", status: "issued" },
      { leg: "delivery", amount: 36.21, currency: "EUR", status: "held" },
    ],
    photoVerdict: "review",
  });
  assert.doesNotMatch(text(f), /checking the delivery photo by hand/);
  assert.match(text(f), /waiting on a check by a colleague/);
  assert.match(text(f), /Nothing is needed from the florist/);
});

test("a null amount never renders as a number and never reaches the allow-list", () => {
  // The repo-wide rule: guard nulls before arithmetic, and never fabricate.
  const f = buildSupportFacts({
    ...base,
    payouts: [{ leg: "accept", amount: null, currency: "EUR", status: "issued" }],
  });
  assert.deepEqual(f.allowedAmounts, []);
  assert.doesNotMatch(text(f), /null|NaN|undefined/);
  assert.doesNotMatch(text(f), /70% payment/);
});

test("a missing delivery date produces no sentence about the delivery date", () => {
  const f = buildSupportFacts({ ...base, order: { ...base.order, delivery_at: null } });
  assert.doesNotMatch(text(f), /due to be delivered/);
  assert.doesNotMatch(text(f), /null|Invalid Date/);
});

test("an unparseable date is dropped rather than guessed at", () => {
  const f = buildSupportFacts({ ...base, order: { ...base.order, delivery_at: "not a date" } });
  assert.doesNotMatch(text(f), /due to be delivered/);
});

test("the customer and the order total are never in the facts", () => {
  // Not an oversight to be tidied up later: the florist's payout is their
  // business and our margin is not, and the buyer's contact details must not
  // sit in a prompt to a third-party model.
  const f = buildSupportFacts({
    ...base,
    order: { ...base.order, total: 240, buyer_name: "Ana Torres", buyer_email: "ana@example.com" },
  });
  const all = text(f);
  assert.doesNotMatch(all, /240/);
  assert.doesNotMatch(all, /Ana|ana@example/);
});

test("the next step is spelled out while the photo is outstanding", () => {
  const f = buildSupportFacts(base);
  assert.match(text(f), /upload one clear photo/);
});

test("once the photo has passed, we stop asking for it", () => {
  const f = buildSupportFacts({ ...base, photoVerdict: "pass" });
  assert.doesNotMatch(text(f), /upload one clear photo/);
  assert.match(text(f), /passed our check/);
});

test("an open problem hands the conversation over instead of answering round it", () => {
  const f = buildSupportFacts({ ...base, openIssues: 1 });
  assert.match(text(f), /hand the conversation over/);
  assert.equal(f.hasOpenIssue, true);
});

test("no open issue means hasOpenIssue is false", () => {
  const f = buildSupportFacts({ ...base, openIssues: 0 });
  assert.equal(f.hasOpenIssue, false);
});

test("nothing to say is reported as empty, not as a short list", () => {
  // An empty fact list is the input that most reliably produces confident
  // nonsense, so the caller escalates instead of prompting on it.
  assert.equal(buildSupportFacts({ order: null, assignment: null, payouts: [], photoVerdict: null, openIssues: 0 }).empty, true);
  // An order name on its own is not enough to answer anything from.
  assert.equal(
    buildSupportFacts({
      order: { order_name: "#1042", delivery_at: null, delivery_window: null, status: null },
      assignment: null, payouts: [], photoVerdict: null, openIssues: 0,
    }).empty,
    true
  );
  assert.equal(buildSupportFacts(base).empty, false);
});

test("legs are stated in payment order regardless of row order", () => {
  const f = buildSupportFacts({ ...base, payouts: [...base.payouts].reverse() });
  const all = text(f);
  assert.ok(all.indexOf("70% payment") < all.indexOf("30% payment"));
});

test("an amount that IS in the facts still fails the guard for a different conversation", () => {
  // Restating the guard's contract from this side: these numbers authorise
  // nothing outside the conversation they were computed for.
  const mine = buildSupportFacts(base);
  const theirs = buildSupportFacts({
    ...base,
    payouts: [{ leg: "accept", amount: 120, currency: "EUR", status: "issued" }],
  });
  assert.equal(moneyClaimOutsideFacts("We sent €120.00.", mine.allowedAmounts), true);
  assert.equal(moneyClaimOutsideFacts("We sent €120.00.", theirs.allowedAmounts), false);
});

// --- who and where -----------------------------------------------------------
// A florist asked "what's the phone number of the recipient?" and was escalated
// to a human. We hold the number, and the order page shows them the recipient
// and full address the moment they accept — so the escalation was the fact list
// being narrower than the screen the question came from.

const withRecipient = {
  ...base,
  order: {
    ...base.order,
    recipient_name: "Marta Serra",
    recipient_phone: "+34 600 123 456",
    delivery_address: { address1: "Carrer de Mallorca 401", zip: "08013", city: "Barcelona", country_code: "ES" },
  },
};

test("an accepted order's facts carry the recipient, their phone and the address", () => {
  const facts = buildSupportFacts(withRecipient);
  const all = facts.lines.join("\n");
  assert.match(all, /\+34 600 123 456/);
  assert.match(all, /Marta Serra/);
  assert.match(all, /Carrer de Mallorca 401, 08013 Barcelona, ES/);
});

test("none of it appears before the florist has accepted", () => {
  // Same PII rule the order page enforces server-side: address and recipient
  // are nulled until accept.
  const facts = buildSupportFacts({
    ...withRecipient,
    assignment: { status: "sent", accepted_at: null, delivered_at: null },
  });
  const all = facts.lines.join("\n");
  assert.doesNotMatch(all, /Marta Serra/);
  assert.doesNotMatch(all, /600 123 456/);
  assert.doesNotMatch(all, /Mallorca/);
});

test("a missing phone is stated, not left silent", () => {
  // Silence reads to the model as "don't mention it", and the florist gets an
  // answer about everything except what they asked.
  const facts = buildSupportFacts({
    ...withRecipient,
    order: { ...withRecipient.order, recipient_phone: null },
  });
  assert.match(facts.lines.join("\n"), /no phone number for the recipient/i);
});

test("sharing the recipient does not open the door to the buyer", () => {
  // Two different people, and only one of them is the florist's business. The
  // RECIPIENT is who they are delivering to — name, address and phone, all of
  // which the order page already shows them once they accept. The BUYER paid
  // for it, and their details (and our margin) stay out of the prompt exactly
  // as before.
  const facts = buildSupportFacts({
    ...withRecipient,
    order: { ...withRecipient.order, total: 240, buyer_name: "Ana Torres", buyer_email: "ana@example.com", buyer_phone: "+44 7700 900111" },
  });
  const all = facts.lines.join("\n");
  assert.match(all, /600 123 456/);          // the recipient: shared
  assert.doesNotMatch(all, /Ana|ana@example/); // the buyer: not
  assert.doesNotMatch(all, /7700 900111/);
  assert.doesNotMatch(all, /240/);
});

test("a phone number is not mistaken for a money claim by the guard", () => {
  // The guard only flags digits sitting next to a currency marker or a %, but
  // this is the line where that assumption is load-bearing.
  const facts = buildSupportFacts(withRecipient);
  const reply = "You can reach Marta Serra on +34 600 123 456.";
  assert.equal(moneyClaimOutsideFacts(reply, facts.allowedAmounts), false);
});

// --- the 30% before it exists as a row ---------------------------------------
// The window every florist asks in: accepted, photo not yet sent, so the
// delivery payout row does not exist. Both the 30% and the photo instruction
// used to be gated on that row, so the agent had nothing to say — and, unable
// to answer, flagged the whole turn. A correct answer to everything else in the
// message became a draft nobody sent.

const acceptedOnly = {
  ...base,
  payouts: [{ leg: "accept", amount: 43.4, currency: "EUR", status: "issued" }],
  photoVerdict: null,
};

test("the 30% is explained even with no delivery payout row", () => {
  const f = buildSupportFacts(acceptedOnly);
  const all = text(f);
  assert.match(all, /remaining 30%/i);
  assert.match(all, /photo has been received and approved|delivery photo has been received/i);
});

test("and so is the photo the florist still has to send", () => {
  const f = buildSupportFacts(acceptedOnly);
  assert.match(text(f), /upload one clear photo/);
});

test("no amount is invented for a leg that does not exist yet", () => {
  // The rule is knowable; the figure is not. Only the accept leg's amount may
  // be on the allow-list.
  const f = buildSupportFacts(acceptedOnly);
  assert.deepEqual(f.allowedAmounts, [43.4]);
  for (const line of f.lines) {
    assert.equal(moneyClaimOutsideFacts(line, f.allowedAmounts), false, line);
  }
});

test("once the delivery leg exists, the placeholder gives way to the real row", () => {
  const f = buildSupportFacts(base); // base has both legs
  const all = text(f);
  assert.doesNotMatch(all, /has not been scheduled yet/);
  assert.match(all, /36\.21 EUR/);
});

test("nothing about the 30% is said before the florist has accepted", () => {
  const f = buildSupportFacts({
    ...acceptedOnly,
    assignment: { status: "sent", accepted_at: null, delivered_at: null },
  });
  assert.doesNotMatch(text(f), /remaining 30%/i);
});

// ---- paid in full on accept (a tier with a 0% delivery leg) ------------------
//
// The risk these cover is specific. "30%" is an ALWAYS-allowed percentage in
// cxAgentGuard (it is our own published policy), so a reply telling a paid-in-full
// florist their remaining 30% is on the way sails through every money guard we
// have and is still completely false. The only defence is that the fact list
// never says it, which is what these assert.

const fullBase = {
  ...base,
  payouts: [{ leg: "accept", amount: 120.5, currency: "EUR", status: "issued" }],
  singlePayment: true,
};

test("a paid-in-full florist is never told about a remaining 30%", () => {
  const f = buildSupportFacts(fullBase);
  const t = text(f);
  assert.doesNotMatch(t, /30%/);
  assert.doesNotMatch(t, /70%/);
  // The exact sentence a split-tier florist gets, which must not appear here.
  assert.doesNotMatch(t, /remaining 30% has not been scheduled/i);
  assert.match(t, /full payment, due on acceptance/);
  assert.match(t, /no second payment/i);
  assert.match(t, /nothing further is owed/i);
});

test("the paid-in-full line keeps the photo obligation, and says it releases nothing", () => {
  // The failure mode on the other side: a florist reads "you are fully paid"
  // and concludes the photo is optional. It is not — it is our only proof the
  // delivery happened, and the customer's delivered email carries it.
  const t = text(buildSupportFacts(fullBase));
  assert.match(t, /delivery photo is still required as proof/i);
  assert.match(t, /releases no money/i);
});

test("paid-in-full facts still survive the money guard they will be graded against", () => {
  const f = buildSupportFacts(fullBase);
  assert.deepEqual(f.allowedAmounts, [120.5]);
  for (const line of f.lines) {
    assert.equal(moneyClaimOutsideFacts(line, f.allowedAmounts), false, line);
  }
});

test("the split wording is what an absent singlePayment falls back to", () => {
  // `singlePayment` is required by the type but callers are JS-adjacent at the
  // edges; the safe default is the deal almost every florist is on, and it is
  // the one that understates rather than over-promises.
  const t = text(buildSupportFacts({ ...base, singlePayment: undefined }));
  assert.match(t, /70% payment, due on acceptance/);
});
