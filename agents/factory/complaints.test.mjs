// node --test agents/factory/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  parseCsv, complaintFromRow, complaintFromOctocom, orderNumberOf, redact, isComplaint, classifyComplaint, complaintAlert,
} from "./complaints.mjs";
import { DAY_MS, ruleCardPlan, quietCards } from "./general-rules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-10-27T12:00:00Z");
const daysAgo = (d) => new Date(NOW - d * DAY_MS).toISOString();

test("CSV export: quoted commas, quotes and line breaks survive, and each row becomes one complaint", () => {
  const rows = parseCsv(readFileSync(join(here, "fixtures/complaints.csv"), "utf8"));
  const list = rows.map((r) => complaintFromRow(r, "csv"));
  assert.equal(list.length, 6);
  assert.deepEqual(list[0], {
    ref: "csv:T-101", source: "csv", order_number: "1234567", received_at: "2026-10-25T09:00:00.000Z",
    text: 'The flowers never arrived, and the card said "delivered".\nVery disappointed.',
  });
  assert.equal(list[3].error, "no text");
  assert.equal(list[4].error, "no date");
});

test("a row with no id still gets the same ref on every import, so a rerun never counts it twice", () => {
  const r = { order: "#123456", complaint: "Arrived late", date: "2026-10-20" };
  assert.equal(complaintFromRow(r, "json").ref, complaintFromRow({ ...r }, "json").ref);
  assert.notEqual(complaintFromRow(r, "json").ref, complaintFromRow({ ...r, complaint: "Arrived dead" }, "json").ref);
});

test("an Octocom conversation gives the customer's words only, its order number and its start date", () => {
  const c = complaintFromOctocom({
    id: "oc1", createdAt: "2026-10-26T08:00:00Z",
    messages: [
      { sender: "customer", text: "Order 1234567 still hasn't arrived!" },
      { sender: "bot", text: "Your order 9999999 is on its way" },
      { sender: "customer", text: "On Mon, Bob wrote:\n> quoted" },
    ],
  });
  assert.deepEqual(c, { ref: "octocom:conversation:oc1", source: "octocom", order_number: "1234567", received_at: "2026-10-26T08:00:00.000Z", text: "Order 1234567 still hasn't arrived!" });
});

test("order numbers: '#1234567', 'order 1234567' and 'FC-1234567' are the same order; short numbers are not orders", () => {
  for (const s of ["#1234567", "order 1234567", "FC-1234567", "1234567"]) assert.equal(orderNumberOf(s), "1234567");
  assert.equal(orderNumberOf("I paid 45 euros"), null);
});

test("quotes keep no email address or phone number", () => {
  const q = redact("Call me on +34 612 345 678 or mail ana.perez@example.com about #1234567");
  assert.ok(!q.includes("612") && !q.includes("ana.perez"), q);
  assert.ok(q.includes("#1234567"));
  assert.ok(redact("x".repeat(1000)).length <= 280);
});

test("each complaint lands on the general rule its words point at, in five languages", () => {
  const cases = [
    ["The flowers never arrived", "never-arrived", "accepted-gets-delivered"],
    ["Las flores no han llegado", "never-arrived", "accepted-gets-delivered"],
    ["They came a day late, for a birthday!", "late", "accepted-gets-delivered"],
    ["Die Blumen waren welk", "wrong-flowers", "photo-proves-delivery"],
    ["Ce n'est pas ce que j'ai commandé", "wrong-flowers", "photo-proves-delivery"],
    ["Delivered to the wrong address", "wrong-address", "order-on-map"],
    ["You charged me twice, I want a refund", "charged-wrong", "pay-exactly-owed"],
    ["My order was cancelled without telling me", "order-lost", "order-in-clean"],
    ["The email said delivered but nobody got anything yet? Tracking is wrong", "status-wrong", "shopify-agrees"],
    ["Nessuna risposta dal servizio clienti", "no-reply", "someone-watching"],
  ];
  for (const [text, topic, rule] of cases) {
    const got = classifyComplaint(text, null);
    assert.deepEqual([got.topic, got.rule], [topic, rule], text);
  }
});

test("a complaint no rule covers is a maybe-product-change, never a rule", () => {
  assert.deepEqual(pick(classifyComplaint("Your prices are far too expensive", null)), ["price", null]);
  assert.deepEqual(pick(classifyComplaint("The website kept crashing at checkout", null)), ["website", null]);
  assert.deepEqual(pick(classifyComplaint("I am very unhappy and disappointed", null)), ["other", null]);
});
const pick = (c) => [c.topic, c.rule];

test("the linked order decides where 'never arrived' belongs: nobody near, nobody answered, or not delivered", () => {
  const text = "My flowers never arrived";
  assert.equal(classifyComplaint(text, { status: "escalated", escalation_reason: "pool_exhausted" }).rule, "area-has-florists");
  assert.equal(classifyComplaint(text, { status: "reaching_out" }).rule, "offer-gets-answer");
  assert.equal(classifyComplaint(text, { status: "matched" }).rule, "offer-gets-answer");
  assert.equal(classifyComplaint(text, { status: "accepted" }).rule, "accepted-gets-delivered");
  assert.match(classifyComplaint(text, { status: "reaching_out", order_name: "#1" }).why, /reaching_out/);
});

test("only complaints count from Octocom: a plain question is not one", () => {
  assert.equal(isComplaint("What time do you deliver on Sundays?"), false);
  assert.equal(isComplaint("How much is delivery to Madrid?"), false);
  assert.equal(isComplaint("The bouquet arrived wilted"), true);
  assert.equal(isComplaint("Estoy muy decepcionada con el servicio"), true);
});

test("ordinary questions and greetings that share a rule's words are not complaints", () => {
  for (const text of [
    "Can you deliver late afternoon on Friday?",
    "Is it too late to change the card message?",
    "Hi, could you send me the tracking link please?",
    "What is your refund policy before I order?",
    "Buenas tardes, quiero enviar un ramo a Sevilla",
  ]) assert.equal(isComplaint(text), false, text);
  for (const text of ["The flowers arrived a day late", "They were late", "Las flores llegaron tarde", "Tracking says delivered but nothing came"]) {
    assert.equal(isComplaint(text), true, text);
  }
});

test("a greeting never decides the rule: the clearer topic in the message does", () => {
  assert.deepEqual(pick(classifyComplaint("Buenas tardes, las flores llegaron marchitas", null)), ["wrong-flowers", "photo-proves-delivery"]);
  assert.deepEqual(pick(classifyComplaint("Hello, refund please: you charged me twice", null)), ["charged-wrong", "pay-exactly-owed"]);
  assert.deepEqual(pick(classifyComplaint("Too late", null)), ["late", "accepted-gets-delivered"]);
});


// ---- complaints -> alerts -> the base's card life (general-rules.mjs) ----

const complaint = (id, text, ago, order_number = id) => ({ ref: `csv:${id}`, source: "csv", order_number, received_at: daysAgo(ago), text });
const alertOf = (c, order = null) => complaintAlert(c, order, classifyComplaint(c.text, order), c.received_at.slice(0, 10));
const late = (id, ago) => alertOf(complaint(id, "The flowers came a day late", ago));

test("a complaint is an alert with source complaint, placed when the customer wrote, masked, on the rule its words pick", () => {
  const a = alertOf(complaint("T1", "Delivered to the wrong address, call +34 612 345 678", 2), { id: "o1", order_name: "#T1" });
  assert.equal(a.source, "complaint");
  assert.equal(a.rule_id, "order-on-map");
  assert.equal(a.match, "near");
  assert.equal(a.key, "order-on-map");
  assert.equal(a.placed_at, daysAgo(2));
  assert.equal(a.last_seen_at, daysAgo(2));
  assert.deepEqual([a.ref.order_id, a.ref.order_name, a.ref.topic], ["o1", "#T1", "wrong-address"]);
  assert.ok(!a.label.includes("612"), a.label);
});

test("the order's state gives the exact situation when it names one", () => {
  const c = complaint("1", "My flowers never arrived", 1);
  const none = alertOf(c, { id: "o", order_name: "#1", status: "escalated", escalation_reason: "pool_exhausted" });
  assert.deepEqual([none.rule_id, none.key, none.match, none.why], ["area-has-florists", "match-none", "exact", null]);
  const lateOne = alertOf(complaint("2", "They came late", 1), { id: "o", order_name: "#2", status: "accepted" });
  assert.deepEqual([lateOne.rule_id, lateOne.key, lateOne.match], ["accepted-gets-delivered", "deliver-late", "exact"]);
});

test("one alert per complaint: two customers on one order are two alerts, a rerun is the same one, a complaint with no order merges with nothing", () => {
  const a = alertOf(complaint("A", "The flowers came late", 1, "1234567"));
  const b = alertOf(complaint("B", "The flowers came late", 1, "1234567"));
  assert.notEqual(a.alert_id, b.alert_id);
  const moved = alertOf(complaint("A", "The flowers came late", 1, "1234567"), { id: "o", order_name: "#1234567", status: "reaching_out" });
  assert.equal(moved.alert_id, a.alert_id, "the order moved on, the complaint did not");
  assert.notEqual(alertOf(complaint("X", "Too late", 1, null)).alert_id, alertOf(complaint("Y", "Too late", 1, null)).alert_id);
});

test("two complaints on a rule in 7 days are no card, the third opens the rule's card for its manager", () => {
  assert.deepEqual(ruleCardPlan({ alerts: [late("1", 1), late("2", 2)], cards: [], now: NOW }), []);
  const plan = ruleCardPlan({ alerts: [late("1", 1), late("2", 2), late("3", 6)], cards: [], now: NOW });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].action, "open");
  assert.equal(plan[0].card.general_rule, "accepted-gets-delivered");
  assert.equal(plan[0].card.manager, "donna");
  assert.equal(plan[0].card.evidence.count, 3);
  assert.deepEqual(plan[0].card.evidence.examples.map((e) => e.source), ["complaint", "complaint", "complaint"]);
});

test("a complaint older than 7 days does not count toward opening", () => {
  assert.deepEqual(ruleCardPlan({ alerts: [late("1", 1), late("2", 2), late("3", 8)], cards: [], now: NOW }), []);
});

test("a maybe-product-change is an alert on no rule, never a card; money lands on Jessica's rule", () => {
  const price = ["1", "2", "3"].map((id) => alertOf(complaint(id, "Your prices are far too expensive", 1)));
  for (const a of price) assert.deepEqual([a.rule_id, a.match, a.key], [null, "none", "price"]);
  assert.deepEqual(ruleCardPlan({ alerts: price, cards: [], now: NOW }), []);
  const money = ["4", "5", "6"].map((id) => alertOf(complaint(id, "You charged me twice, I want a refund", 1)));
  const plan = ruleCardPlan({ alerts: money, cards: [], now: NOW });
  assert.deepEqual(plan.map((p) => [p.action, p.card.general_rule, p.card.manager]), [["open", "pay-exactly-owed", "jessica"]]);
});

test("after the fix merged, a card closes only once the rule has been quiet 7 days since the last complaint", () => {
  const card = (lastComplaintAgo) => ({ id: "k1", status: "in-progress", merged_at: daysAgo(10), last_seen_at: late("1", lastComplaintAgo).last_seen_at, runs: [] });
  assert.deepEqual(quietCards([card(6)], NOW), []);
  assert.deepEqual(quietCards([card(7)], NOW), ["k1"]);
});

test("one new complaint on a closed rule reopens the same card, not a new one", () => {
  const closed = { id: "k1", general_rule: "order-on-map", status: "done", closed_at: daysAgo(5) };
  const old = alertOf(complaint("1", "Delivered to the wrong address", 6));
  assert.deepEqual(ruleCardPlan({ alerts: [old], cards: [closed], now: NOW }), []);
  const fresh = alertOf(complaint("2", "Delivered to the wrong address", 1));
  assert.deepEqual(ruleCardPlan({ alerts: [old, fresh], cards: [closed], now: NOW }).map((p) => [p.action, p.id]), [["reopen", "k1"]]);
});
