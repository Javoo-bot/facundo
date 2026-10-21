// Unit tests for the Orders list's location/countdown helpers. Run under
// node's native TS type-stripping (imports the .ts directly):
//   node --test components/orders/orderDerive.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deliveryCountdown,
  deliveryDeadlineLabel,
  deriveCity,
  deriveCountry,
  roundedDuration,
  orderAgeLabel,
  dueInLabel,
  findAcceptedAssignment,
  reachoutStats,
} from "./orderDerive.ts";

// Fixed clock (and UTC timezone, since deliveryDeadlineLabel's Today/Tomorrow/
// weekday boundaries are calendar-day math in local time) so the tests are
// deterministic regardless of the machine/CI running them.
const NOW = Date.UTC(2026, 6, 21, 12, 0, 0); // 2026-07-21T12:00:00Z, a Tuesday
const realDateNow = Date.now;
const realTZ = process.env.TZ;
test.before(() => { process.env.TZ = "UTC"; Date.now = () => NOW; });
test.after(() => { Date.now = realDateNow; process.env.TZ = realTZ; });
const at = (h) => new Date(NOW + h * 3600_000).toISOString(); // NOW + h hours

test("deriveCity prefers delivery_address.city", () => {
  assert.equal(deriveCity({ delivery_address: { city: "Barcelona" }, delivery_area: "Girona · Catalonia" }), "Barcelona");
});

test("deriveCity falls back to the first delivery_area segment", () => {
  assert.equal(deriveCity({ delivery_address: null, delivery_area: "Girona · Catalonia" }), "Girona");
  assert.equal(deriveCity({ delivery_address: {}, delivery_area: "Girona" }), "Girona");
});

test("deriveCity is honest when nothing is known", () => {
  assert.equal(deriveCity({ delivery_address: null, delivery_area: null }), "—");
  assert.equal(deriveCity({ delivery_address: { city: "" }, delivery_area: "" }), "—");
});

test("deriveCountry prefers delivery_address.country, then country_code", () => {
  assert.equal(deriveCountry({ delivery_address: { country: "ES" }, delivery_area: "Girona · Catalonia" }), "ES");
  assert.equal(deriveCountry({ delivery_address: { country_code: "FR" }, delivery_area: null }), "FR");
});

test("deriveCountry falls back to the second delivery_area segment", () => {
  assert.equal(deriveCountry({ delivery_address: null, delivery_area: "Girona · Catalonia" }), "Catalonia");
});

test("deriveCountry is honest when nothing is known", () => {
  assert.equal(deriveCountry({ delivery_address: null, delivery_area: "Girona" }), "—");
  assert.equal(deriveCountry({ delivery_address: null, delivery_area: null }), "—");
});

test("deliveryCountdown reports days/hours/minutes left for future deliveries", () => {
  assert.equal(deliveryCountdown("matched", at(72)), "3d left");
  assert.equal(deliveryCountdown("matched", at(6)), "6h left");
  assert.equal(deliveryCountdown("matched", at(0.5)), "<1h left");
});

test("deliveryCountdown reports Overdue for a past deadline still in flight", () => {
  assert.equal(deliveryCountdown("out_for_delivery", at(-2)), "Overdue");
});

test("deliveryCountdown reports Done once delivery has actually happened", () => {
  assert.equal(deliveryCountdown("delivered", at(-5)), "Done");
  assert.equal(deliveryCountdown("paid", at(-5)), "Done");
  assert.equal(deliveryCountdown("closed", at(-5)), "Done");
});

test("deliveryCountdown reports — for cancelled orders and missing/invalid dates", () => {
  assert.equal(deliveryCountdown("cancelled", at(-5)), "—");
  assert.equal(deliveryCountdown("matched", null), "—");
  assert.equal(deliveryCountdown("matched", "not-a-date"), "—");
});

test("deliveryDeadlineLabel says Today/Tomorrow for the next two calendar days, no year", () => {
  assert.equal(deliveryDeadlineLabel("matched", at(2)), "Today 02:00 PM");
  assert.equal(deliveryDeadlineLabel("matched", at(20)), "Tomorrow 08:00 AM");
});

test("deliveryDeadlineLabel uses a weekday short-form out to a week", () => {
  // NOW is Tuesday 2026-07-21; +4 days lands on Saturday.
  assert.equal(deliveryDeadlineLabel("matched", at(4 * 24)), "Sat 12:00 PM");
});

test("deliveryDeadlineLabel falls back to a dateless-year date beyond a week", () => {
  assert.equal(deliveryDeadlineLabel("matched", at(10 * 24)), "Jul 31, 12:00 PM");
});

test("deliveryDeadlineLabel reports Overdue for a past deadline still in flight", () => {
  assert.equal(deliveryDeadlineLabel("out_for_delivery", at(-2)), "Overdue");
});

test("deliveryDeadlineLabel reports Done once delivery has actually happened", () => {
  assert.equal(deliveryDeadlineLabel("delivered", at(-5)), "Done");
  assert.equal(deliveryDeadlineLabel("paid", at(-5)), "Done");
  assert.equal(deliveryDeadlineLabel("closed", at(-5)), "Done");
});

test("deliveryDeadlineLabel reports — for cancelled orders and missing/invalid dates", () => {
  assert.equal(deliveryDeadlineLabel("cancelled", at(-5)), "—");
  assert.equal(deliveryDeadlineLabel("matched", null), "—");
  assert.equal(deliveryDeadlineLabel("matched", "not-a-date"), "—");
});

test("roundedDuration renders sub-minute durations as <1m", () => {
  assert.equal(roundedDuration(0), "<1m");
  assert.equal(roundedDuration(30_000), "<1m");
  assert.equal(roundedDuration(59_999), "<1m");
});

test("roundedDuration renders sub-hour durations in rounded minutes", () => {
  assert.equal(roundedDuration(40 * 60_000), "40m");
});

test("roundedDuration renders sub-day durations in rounded hours", () => {
  assert.equal(roundedDuration(5 * 3_600_000), "5h");
});

test("roundedDuration renders sub-week durations in whole days", () => {
  assert.equal(roundedDuration(1 * 86_400_000), "1d");
  assert.equal(roundedDuration(2 * 86_400_000), "2d");
});

test("roundedDuration renders week-plus durations as weeks and remainder days", () => {
  assert.equal(roundedDuration(10 * 86_400_000), "1w 3d");
});

test("roundedDuration renders an exact week with no remainder as just weeks", () => {
  assert.equal(roundedDuration(14 * 86_400_000), "2w");
});

test("orderAgeLabel reports a rounded duration since a valid created_at", () => {
  assert.equal(orderAgeLabel(at(-5)), "5h");
});

test("orderAgeLabel is honest for missing/unparsable created_at", () => {
  assert.equal(orderAgeLabel(null), "—");
  assert.equal(orderAgeLabel("not-a-date"), "—");
});

test("dueInLabel reports a rounded countdown for a future deadline", () => {
  assert.equal(dueInLabel("matched", at(5)), "5h");
});

test("dueInLabel reports an Overdue duration for a past deadline still in flight", () => {
  assert.equal(dueInLabel("out_for_delivery", at(-2)), "Overdue 2h");
});

test("dueInLabel reports Done once delivery has actually happened", () => {
  assert.equal(dueInLabel("delivered", at(-5)), "Done");
  assert.equal(dueInLabel("paid", at(-5)), "Done");
  assert.equal(dueInLabel("closed", at(-5)), "Done");
});

test("dueInLabel reports — for cancelled orders and missing/invalid dates", () => {
  assert.equal(dueInLabel("cancelled", at(-5)), "—");
  assert.equal(dueInLabel("matched", null), "—");
  assert.equal(dueInLabel("matched", "not-a-date"), "—");
});

test("findAcceptedAssignment returns null when nobody has accepted yet", () => {
  assert.equal(
    findAcceptedAssignment([
      { id: "a", status: "candidate", florist_id: "f1", rank: 1 },
      { id: "b", status: "sent", florist_id: "f2", rank: 2 },
      { id: "c", status: "opened", florist_id: "f3", rank: 3 },
    ]),
    null
  );
});

test("findAcceptedAssignment ignores candidates/sent/opened — only accepted/delivered count", () => {
  const accepted = { id: "b", status: "accepted", florist_id: "f2", rank: 2 };
  assert.deepEqual(
    findAcceptedAssignment([
      { id: "a", status: "candidate", florist_id: "f1", rank: 1 },
      accepted,
      { id: "c", status: "sent", florist_id: "f3", rank: 3 },
    ]),
    accepted
  );
});

test("findAcceptedAssignment also matches a delivered assignment", () => {
  const delivered = { id: "a", status: "delivered", florist_id: "f1", rank: 1 };
  assert.deepEqual(findAcceptedAssignment([delivered]), delivered);
});

test("reachoutStats counts sent/opened from assignment status when no engagement data exists", () => {
  const stats = reachoutStats([
    { id: "a", status: "candidate" },
    { id: "b", status: "sent" },
    { id: "c", status: "opened" },
    { id: "d", status: "declined" },
    { id: "e", status: "accepted" },
  ]);
  assert.deepEqual(stats, { sent: 4, opened: 2, clicked: 0, signedIn: 0, declined: 1 });
});

test("reachoutStats prefers finer-grained engagement evidence for clicked/signed-in", () => {
  const engagement = {
    a: { at: { sent: "2026-01-01", delivered: null, opened: "2026-01-01", clicked: "2026-01-01", signed_in: "2026-01-01" }, via: {} },
    b: { at: { sent: "2026-01-01", delivered: null, opened: null, clicked: null, signed_in: null }, via: {} },
  };
  const stats = reachoutStats(
    [
      { id: "a", status: "sent" },
      { id: "b", status: "candidate" },
    ],
    engagement
  );
  assert.deepEqual(stats, { sent: 2, opened: 1, clicked: 1, signedIn: 1, declined: 0 });
});

test("reachoutStats returns all-zero for no candidates", () => {
  assert.deepEqual(reachoutStats([]), { sent: 0, opened: 0, clicked: 0, signedIn: 0, declined: 0 });
});
