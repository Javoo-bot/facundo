import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { byDeadline, countdown, operatorAction, operatorHref, severityFor } from "./operator.ts";

// ---------------------------------------------------------------------------
// The Operator panel exists so a new CX hire can read the queue on their first
// Monday. That promise is only kept if EVERY reason cxAttention can produce has
// a sentence written for it — so the first test walks the real source files and
// fails when a label is added upstream without a translation here.
// ---------------------------------------------------------------------------

/** Pull every string literal assigned to a `label:` in a source file. */
function labelsIn(file) {
  const src = readFileSync(new URL(file, import.meta.url), "utf8");
  const out = new Set();
  // label: "…" and label: `…${x}…` (the parameterised ones keep their prefix)
  for (const m of src.matchAll(/label:\s*"([^"]+)"/g)) out.add(m[1]);
  for (const m of src.matchAll(/label:\s*`([^`$]*)/g)) if (m[1].trim()) out.add(m[1]);
  return out;
}

test("every reason cxAttention can emit has a plain-English translation", () => {
  const labels = new Set([...labelsIn("./cxAttentionRules.ts"), ...labelsIn("./cxAttention.ts")]);
  // Sanity: if the scrape ever stops finding labels, this test would pass
  // vacuously and stop protecting anything.
  assert.ok(labels.size >= 15, `expected to scrape 15+ labels, found ${labels.size}`);

  const unmapped = [];
  for (const label of labels) {
    // Category is irrelevant to the lookup for an explicitly-mapped label; a
    // wrong guess here would only ever fall through to the category default,
    // which is exactly what we are checking does NOT happen.
    const got = operatorAction({ category: "place", label });
    if (got.headline === "This order still has no florist" && label !== "Awaiting reach-out") unmapped.push(label);
  }
  assert.deepEqual(unmapped, [], `unmapped reason labels: ${unmapped.join(" | ")}`);
});

test("a placement reason becomes a sentence and an imperative button", () => {
  const a = operatorAction({ category: "place", label: "Offer stalling — SLA breached" });
  assert.equal(a.headline, "No florist has answered yet");
  assert.equal(a.action, "Contact a florist");
  // No jargon leaks through into what the operator reads.
  for (const word of ["SLA", "escalat", "wave", "candidate", "status"]) {
    assert.ok(!a.headline.toLowerCase().includes(word.toLowerCase()), `headline leaks "${word}"`);
  }
});

test("parameterised money labels match on their prefix, not the whole string", () => {
  // The percentage and the held-reason both vary; the copy must not.
  const seventy = operatorAction({ category: "money", label: "70% held — untrusted tier" });
  const thirty = operatorAction({ category: "money", label: "30% held — operator hold switch" });
  assert.equal(seventy.headline, "Payment is waiting for your approval");
  assert.deepEqual(seventy, thirty);

  const dispute = operatorAction({ category: "money", label: "Card dispute (needs_response)" });
  assert.equal(dispute.action, "Review the dispute");
});

test("a florist question routes to the reply screen, not the order page", () => {
  const a = operatorAction({ category: "message", label: "Florist waiting on a reply (out_of_scope)" });
  assert.equal(a.headline, "A florist asked a question");
  assert.equal(operatorHref("abc-123", a), "/orders/abc-123/reply");
});

test("all six order-issue types get a sentence, not issueLabel's noun phrase", () => {
  // `order_issues.type` is a closed set (see the check constraint in
  // supabase/migrations/2026-07-14-order-issues.sql), and cxAttention renders it
  // through issueLabel("en", type). Those labels are chips — "Missing
  // ingredient", "Issue" — so every one of them must be rewritten here.
  const cases = [
    ["Missing ingredient", "The florist is missing an ingredient"],
    ["Wrong address", "The delivery address looks wrong"],
    ["Address out of range", "The address is outside the florist's range"],
    ["No one home / recipient unavailable", "Nobody was home for the delivery"],
    ["Damaged / wrong recipient", "The flowers were damaged, or went to the wrong person"],
    ["Issue", "The florist reported a problem"],
  ];
  for (const [label, headline] of cases) {
    const a = operatorAction({ category: "message", label });
    assert.equal(a.headline, headline, `issue label "${label}"`);
    assert.equal(a.action, "Reply to the florist");
    // The anchor became a screen: a florist question now opens the writing
    // box at /orders/[id]/reply instead of scrolling the order page to a card
    // sitting among thirteen others.
    assert.equal(a.route, "reply");
  }
});

test("an issue label from outside that set keeps its own text", () => {
  // A staff override (lib/messageOverrides.ts) can change an issueLabel string
  // out from under this file. The overridden text is still human, so it
  // survives rather than being replaced by a generic sentence.
  const a = operatorAction({ category: "message", label: "Ingredient not in stock" });
  assert.equal(a.headline, "Ingredient not in stock");
  assert.equal(a.action, "Open the message");
});

test("an unknown reason in a known category still renders something true", () => {
  const a = operatorAction({ category: "money", label: "Something nobody has written copy for yet" });
  assert.equal(a.headline, "There is a problem with the payment");
  assert.ok(a.action.length > 0);
});

test("\"the list ran out\" does not claim no florist was found", () => {
  // cxAttentionRules used to fall this reason through to the escalated default,
  // whose sentence asserts nobody was found — a claim `candidates_exhausted`
  // explicitly does not make. Staging showed the wrong sentence on a real row.
  const a = operatorAction({ category: "place", label: "The list of shops ran out — nobody looked further" });
  assert.equal(a.headline, "The list of shops ran out");
  assert.equal(a.action, "Find more florists");
  assert.ok(!a.headline.includes("No florist found"));
});

test("a plain action links to the order with no anchor", () => {
  const a = operatorAction({ category: "place", label: "No florist found — escalated" });
  assert.equal(operatorHref("xyz", a), "/orders/xyz");
});

test("\"Contact a florist\" goes to the call card, not the order page", () => {
  // The row that means "pick up the phone to a specific shop" has its own
  // screen: /orders/[id]/call shows that shop, its number, what it did with
  // the offer, and the three outcomes. Every other action stays on the order
  // page, where its control already lives.
  const a = operatorAction({ category: "place", label: "Offer stalling — SLA breached" });
  assert.equal(a.action, "Contact a florist");
  assert.equal(operatorHref("abc-123", a), "/orders/abc-123/call");
});

test("finding more florists runs on the row, it does not navigate", () => {
  // One server call with nothing to decide first, so making it a destination
  // cost a page load, a panel and a trip back. The operator stays on the queue.
  for (const label of [
    "No florist found — escalated",
    "No florist left in range — escalated",
    "Florist went dark, nobody left to hand it to",
    "The list of shops ran out — nobody looked further",
  ]) {
    const a = operatorAction({ category: "place", label });
    assert.equal(a.run, "rematch", label);
    assert.match(a.action, /^Find (a|more) florists?$/, label);
  }
  // The category fallback too — an unknown placement reason still means
  // "this order has no florist", which is the same one call.
  assert.equal(operatorAction({ category: "place", label: "something new upstream" }).run, "rematch");
});

test("a yes with nothing left to decide runs in place", () => {
  // The approval already carries its drafted email; the held payout already
  // carries its amount. The panel's job is the yes, not the form.
  for (const label of [
    "Approve offer to send",
    "Approve match — make candidates live",
    "Approve reassign to next florist",
    "Approve escalation to CX",
    "Approve Shopify write-back",
    "Approve customer ‘assigned’ email",
  ]) {
    assert.equal(operatorAction({ category: "approval", label }).run, "approve", label);
  }
  assert.equal(operatorAction({ category: "approval", label: "anything new upstream" }).run, "approve");
  for (const label of ["70% held — tier-hold", "30% held — photo pending"]) {
    const a = operatorAction({ category: "money", label });
    assert.equal(a.run, "payout", label);
    assert.equal(a.action, "Approve the payment");
  }
});

test("every florist question lands on the writing box", () => {
  for (const label of [
    "Missing ingredient", "Wrong address", "Address out of range",
    "No one home / recipient unavailable", "Damaged / wrong recipient",
    "Florist waiting on a reply", "anything new upstream",
  ]) {
    const a = operatorAction({ category: "message", label });
    assert.equal(operatorHref("o", a), "/orders/o/reply", label);
    assert.equal(a.anchor, undefined, `${label} must not also carry an anchor`);
  }
});

test("anything needing words or judgement keeps its own screen", () => {
  // The line: a row runs in place when the only input is yes. It navigates
  // when the operator has to WRITE something, or JUDGE something the row
  // cannot show them.
  for (const r of [
    { category: "place", label: "Offer stalling — SLA breached" },   // which shop to phone
    { category: "message", label: "Wrong address" },                 // a reply to compose
    { category: "message", label: "Missing ingredient" },
    { category: "message", label: "Florist waiting on a reply" },
    { category: "delivery", label: "Late — past the delivery window" },
    { category: "money", label: "Payout failed" },                   // not a yes — a fix
    { category: "money", label: "Card dispute opened" },
    { category: "place", label: "Out of time — place this now" },
  ]) {
    assert.equal(operatorAction(r).run, undefined, `${r.label} must keep its screen`);
  }
});

test("nothing else was diverted to the call card", () => {
  // Guard against a second reason quietly acquiring route:"call" — the card
  // only knows how to be a phone call about an unanswered offer. A delivery
  // problem or a held payout sent there would offer the wrong three outcomes.
  const others = [
    { category: "place", label: "No florist found — escalated" },
    { category: "delivery", label: "Late — past the delivery window" },
    { category: "message", label: "Missing ingredient" },
    { category: "money", label: "70% held — tier-hold" },
    { category: "approval", label: "Approve offer to send" },
  ];
  for (const r of others) {
    const act = operatorAction(r);
    assert.notEqual(act.route, "call", `${r.label} must not route to the call card`);
    assert.ok(operatorHref("o", act).startsWith("/orders/o"), r.label);
    assert.ok(!operatorHref("o", act).endsWith("/call"), r.label);
  }
});

// ---------------------------------------------------------------------------
// The countdown. It is the only thing the page ranks by, so its edges matter
// more than its middle.
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-09-01T12:00:00Z");
const inMs = (ms) => new Date(NOW + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

test("the three deadlines from the brief read as asked", () => {
  assert.deepEqual(countdown(inMs(30 * MIN), NOW), { value: "30", unit: "min left", severity: "crit", overdue: false });
  assert.deepEqual(countdown(inMs(26 * HOUR), NOW), { value: "26", unit: "hours left", severity: "warn", overdue: false });
  assert.deepEqual(countdown(inMs(72 * HOUR), NOW), { value: "3", unit: "days left", severity: "calm", overdue: false });
});

test("units switch at an hour and at two days", () => {
  assert.equal(countdown(inMs(59 * MIN), NOW).unit, "min left");
  assert.equal(countdown(inMs(60 * MIN), NOW).unit, "hour left"); // singular
  assert.equal(countdown(inMs(47 * HOUR), NOW).unit, "hours left");
  assert.equal(countdown(inMs(48 * HOUR), NOW).value, "2");
  assert.equal(countdown(inMs(48 * HOUR), NOW).unit, "days left");
});

test("severity thresholds are inclusive at the boundary", () => {
  assert.equal(severityFor(2 * HOUR), "crit");
  assert.equal(severityFor(2 * HOUR + 1), "warn");
  // 48h itself is calm: it is where the label becomes "2 days", and the
  // quietest row on the page should not share the colour of tonight's.
  assert.equal(severityFor(48 * HOUR - 1), "warn");
  assert.equal(severityFor(48 * HOUR), "calm");
});

test("a passed deadline says how late it is, and is always critical", () => {
  const late = countdown(inMs(-90 * MIN), NOW);
  assert.equal(late.overdue, true);
  assert.equal(late.severity, "crit");
  assert.equal(late.value, "1");
  assert.equal(late.unit, "hour late");

  // Just-passed rounds up to a minute rather than showing "0".
  assert.equal(countdown(inMs(-5_000), NOW).value, "1");
  assert.equal(countdown(inMs(-5_000), NOW).unit, "min late");

  assert.equal(countdown(inMs(-5 * 24 * HOUR), NOW).unit, "days late");
});

test("a late row never says \"left\" — it is not a countdown", () => {
  // The rendering split hangs off `overdue`, but the words have to agree with
  // the shape: "9 days left" inside a red LATE badge would be a contradiction.
  for (const ms of [-1 * MIN, -59 * MIN, -1 * HOUR, -47 * HOUR, -9 * 24 * HOUR]) {
    const c = countdown(inMs(ms), NOW);
    assert.equal(c.overdue, true, `${ms}ms should be overdue`);
    assert.ok(c.unit.endsWith(" late"), `unit was "${c.unit}"`);
    assert.ok(!c.unit.includes("left"));
  }
  // …and the converse: nothing in the future is ever labelled late.
  for (const ms of [1 * MIN, 4 * HOUR, 8 * HOUR, 26 * HOUR, 2 * 24 * HOUR]) {
    const c = countdown(inMs(ms), NOW);
    assert.equal(c.overdue, false);
    assert.ok(c.unit.endsWith(" left"), `unit was "${c.unit}"`);
  }
});

test("the QA spread renders the way it was asked for", () => {
  const spread = [
    [30 * MIN, "30", "min left", "crit"],
    [2 * HOUR, "2", "hours left", "crit"],
    [4 * HOUR, "4", "hours left", "warn"],
    [8 * HOUR, "8", "hours left", "warn"],
    [26 * HOUR, "26", "hours left", "warn"],
    [2 * 24 * HOUR, "2", "days left", "calm"],
  ];
  for (const [ms, value, unit, severity] of spread) {
    const c = countdown(inMs(ms), NOW);
    assert.deepEqual({ value: c.value, unit: c.unit, severity: c.severity }, { value, unit, severity }, `${ms}ms`);
  }
});

test("a missing or unparsable delivery date never produces NaN", () => {
  for (const bad of [null, undefined, "", "not a date"]) {
    const c = countdown(bad, NOW);
    assert.equal(c.value, "—");
    assert.equal(c.severity, "calm");
    assert.equal(c.overdue, false);
    assert.ok(!Number.isNaN(Number(c.value.replace("—", "0"))));
  }
});

// ---------------------------------------------------------------------------
// The order of the list. The page's whole promise is that reading top to bottom
// IS the order to work in, so the sort has to agree with the countdown column.
// ---------------------------------------------------------------------------

test("the list is ordered by the number it actually shows", () => {
  // The real staging queue, which rendered wrong under urgency order: a 9-day
  // overdue row sat between a 27-minute one and a 1-hour one.
  const rows = [
    { id: "sla-27min", deliveryAt: inMs(27 * MIN), urgency: 100 },
    { id: "overdue-9d", deliveryAt: inMs(-9 * 24 * HOUR), urgency: 90 },
    { id: "range-1h", deliveryAt: inMs(60 * MIN), urgency: 90 },
    { id: "list-25h", deliveryAt: inMs(25 * HOUR), urgency: 85 },
  ];
  assert.deepEqual(
    byDeadline(rows, NOW).map((r) => r.id),
    ["overdue-9d", "sla-27min", "range-1h", "list-25h"]
  );
});

test("urgency breaks a tie between two orders due at the same moment", () => {
  const rows = [
    { id: "question", deliveryAt: inMs(6 * HOUR), urgency: 65 },
    { id: "unanswered-offer", deliveryAt: inMs(6 * HOUR), urgency: 100 },
  ];
  assert.deepEqual(byDeadline(rows, NOW).map((r) => r.id), ["unanswered-offer", "question"]);
});

test("an order with no delivery date sinks to the bottom rather than the top", () => {
  const rows = [
    { id: "no-date", deliveryAt: null, urgency: 105 },
    { id: "unparsable", deliveryAt: "not a date", urgency: 104 },
    { id: "next-week", deliveryAt: inMs(7 * 24 * HOUR), urgency: 40 },
  ];
  const ids = byDeadline(rows, NOW).map((r) => r.id);
  assert.equal(ids[0], "next-week");
  assert.deepEqual(ids.slice(1).sort(), ["no-date", "unparsable"]);
});

test("sorting does not mutate the caller's array", () => {
  // gatherAttention's result is request-cached and shared with the sidebar
  // badge — reordering it in place would reorder it for them too.
  const rows = [
    { id: "b", deliveryAt: inMs(2 * HOUR), urgency: 50 },
    { id: "a", deliveryAt: inMs(1 * HOUR), urgency: 50 },
  ];
  const before = rows.map((r) => r.id);
  byDeadline(rows, NOW);
  assert.deepEqual(rows.map((r) => r.id), before);
});
