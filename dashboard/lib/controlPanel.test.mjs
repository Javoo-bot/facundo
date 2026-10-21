import test from "node:test";
import assert from "node:assert/strict";
import {
  controlChip,
  showContactFlorist,
  isSilentAfterEmail,
  EMAILED_AND_SILENT,
  timeLeftLabel,
  applyControlFilters,
  destinationOptions,
  statusOptions,
  activeFilterCount,
} from "./controlPanel.ts";

const NOW = Date.parse("2026-09-03T09:00:00.000Z");
const inHours = (h) => new Date(NOW + h * 3_600_000).toISOString();

const asg = (status, withdrawnAt = null) => ({ status, withdrawnAt });

const row = (over = {}) => ({
  id: "11111111-2222-3333-4444-555555555555",
  orderName: "#2000032",
  destination: "Girona, ES",
  status: "reaching_out",
  deliveryAt: inHours(48),
  deliveryWindow: null,
  assignments: [],
  reason: "Needs next florist — no live offer",
  severity: "warn",
  ...over,
});

// ── the button rule ────────────────────────────────────────────────────────
// docs/order-flow/3-system-order-to-florist.md:
//   MORE{"Anyone left to ask?"} --> |no| CALL["the desk phones them"]

test("escalated + a shop emailed and silent shows the button", () => {
  for (const s of EMAILED_AND_SILENT) {
    assert.equal(
      showContactFlorist(row({ status: "escalated", assignments: [asg(s)] })),
      true,
      `${s} should be callable`
    );
  }
});

test("still emailing means no button, however many shops went silent", () => {
  // The engine has someone left to ask, so it keeps emailing. This is the case
  // that dominates production: five orders with 7-14 silent shops each.
  const many = [asg("expired"), asg("expired"), asg("sent"), asg("candidate")];
  assert.equal(showContactFlorist(row({ status: "reaching_out", assignments: many })), false);
  assert.equal(showContactFlorist(row({ status: "matched", assignments: many })), false);
  assert.equal(showContactFlorist(row({ status: "received", assignments: many })), false);
});

test("escalated with only a refusal shows no button — that is an answer, not a gap", () => {
  assert.equal(showContactFlorist(row({ status: "escalated", assignments: [asg("declined")] })), false);
});

test("escalated with nobody ever emailed shows no button", () => {
  assert.equal(
    showContactFlorist(row({ status: "escalated", assignments: [asg("candidate"), asg("queued")] })),
    false
  );
});

test("a withdrawn offer is not someone to phone — we took it back", () => {
  assert.equal(
    showContactFlorist(row({ status: "escalated", assignments: [asg("sent", "2026-09-01T10:00:00Z")] })),
    false
  );
});

test("an accepted order shows no button even though the shop 'did not refuse'", () => {
  // A shop that accepted and then went quiet belongs to the chase_photo flow,
  // not to placing the order with somebody else.
  assert.equal(showContactFlorist(row({ status: "accepted", assignments: [asg("accepted")] })), false);
  assert.equal(showContactFlorist(row({ status: "escalated", assignments: [asg("accepted")] })), false);
  assert.equal(showContactFlorist(row({ status: "escalated", assignments: [asg("delivered")] })), false);
});

test("isSilentAfterEmail excludes every state that is not silence", () => {
  for (const s of ["declined", "candidate", "queued", "reassigned", "released", "accepted", "delivered"]) {
    assert.equal(isSilentAfterEmail(asg(s)), false, `${s} must not count as silent`);
  }
});

// ── the status chip ────────────────────────────────────────────────────────

test("the chip is /orders' own vocabulary, verbatim", () => {
  assert.equal(controlChip(row({ status: "escalated" }), NOW).label, "Escalated");
  assert.equal(
    controlChip(row({ status: "reaching_out", assignments: [asg("expired")] }), NOW).label,
    "No live offer — needs next florist"
  );
  assert.equal(controlChip(row({ status: "accepted", deliveryAt: inHours(48) }), NOW).label, "Accepted");
});

test("a live offer keeps a reaching_out order calm — no second vocabulary papers over it", () => {
  // Deliberate: the reason vocabulary names actions this page does not offer,
  // so a calm word beats a label implying a button that is not there.
  const chip = controlChip(row({ status: "reaching_out", assignments: [asg("sent")] }), NOW);
  assert.equal(chip.label, "Reaching out");
});

// ── time left ──────────────────────────────────────────────────────────────

test("timeLeftLabel is days, or hours when tight — never minutes", () => {
  assert.equal(timeLeftLabel(inHours(96), NOW), "4 days");
  assert.equal(timeLeftLabel(inHours(24), NOW), "1 day");
  assert.equal(timeLeftLabel(inHours(23.9), NOW), "23 hours");
  assert.equal(timeLeftLabel(inHours(9), NOW), "9 hours");
  assert.equal(timeLeftLabel(inHours(1), NOW), "1 hour");
});

test("timeLeftLabel boundaries: under an hour, and exactly now", () => {
  assert.equal(timeLeftLabel(inHours(0.98), NOW), "Under an hour");
  assert.equal(timeLeftLabel(new Date(NOW + 60_000).toISOString(), NOW), "Under an hour");
  assert.equal(timeLeftLabel(new Date(NOW).toISOString(), NOW), "Overdue");
  assert.equal(timeLeftLabel(inHours(-1), NOW), "Overdue");
  assert.equal(timeLeftLabel(inHours(-500), NOW), "Overdue");
});

test("timeLeftLabel never renders a number it cannot justify", () => {
  assert.equal(timeLeftLabel(null, NOW), "—");
  assert.equal(timeLeftLabel(undefined, NOW), "—");
  assert.equal(timeLeftLabel("", NOW), "—");
  assert.equal(timeLeftLabel("not-a-date", NOW), "—");
});

// ── filters ────────────────────────────────────────────────────────────────

test("no filters means every row", () => {
  const rows = [row(), row({ id: "b", orderName: "#2" })];
  assert.equal(applyControlFilters(rows).length, 2);
  assert.equal(applyControlFilters(rows, {}).length, 2);
  assert.equal(applyControlFilters(rows, { order: "  ", status: [] }).length, 2);
});

test("order filter matches a partial order number, and falls back to the id", () => {
  const rows = [row({ orderName: "#2000032" }), row({ id: "b", orderName: "#2000028" })];
  assert.deepEqual(applyControlFilters(rows, { order: "0032" }).map((r) => r.orderName), ["#2000032"]);
  assert.equal(applyControlFilters(rows, { order: "#2000" }).length, 2);
  assert.equal(applyControlFilters([row({ orderName: null, id: "abc123" })], { order: "abc" }).length, 1);
});

test("destination filter is exact", () => {
  const rows = [row({ destination: "Girona, ES" }), row({ id: "b", destination: "Dubrovnik, HR" })];
  assert.deepEqual(applyControlFilters(rows, { destination: "Dubrovnik, HR" }).map((r) => r.id), ["b"]);
  assert.equal(applyControlFilters(rows, { destination: "Girona" }).length, 0);
});

test("status filter selects on the label the column shows", () => {
  const rows = [
    row({ id: "a", status: "escalated" }),
    row({ id: "b", status: "accepted" }),
  ];
  assert.deepEqual(applyControlFilters(rows, { status: ["Escalated"] }, NOW).map((r) => r.id), ["a"]);
  assert.equal(applyControlFilters(rows, { status: ["Escalated", "Accepted"] }, NOW).length, 2);
});

test("date range is inclusive on both ends", () => {
  const rows = [
    row({ id: "a", deliveryAt: "2026-09-02T23:00:00.000Z" }),
    row({ id: "b", deliveryAt: "2026-09-03T09:00:00.000Z" }),
    row({ id: "c", deliveryAt: "2026-09-04T09:00:00.000Z" }),
  ];
  assert.deepEqual(applyControlFilters(rows, { from: "2026-09-03", to: "2026-09-03" }).map((r) => r.id), ["b"]);
  assert.deepEqual(applyControlFilters(rows, { from: "2026-09-03" }).map((r) => r.id), ["b", "c"]);
  assert.deepEqual(applyControlFilters(rows, { to: "2026-09-03" }).map((r) => r.id), ["a", "b"]);
});

test("an order with no delivery date survives the date filter", () => {
  const rows = [row({ id: "none", deliveryAt: null }), row({ id: "far", deliveryAt: "2026-12-01T09:00:00.000Z" })];
  assert.deepEqual(applyControlFilters(rows, { from: "2026-09-03", to: "2026-09-03" }).map((r) => r.id), ["none"]);
});

test("filters combine as AND", () => {
  const rows = [
    row({ id: "a", orderName: "#1", destination: "Girona, ES", status: "escalated" }),
    row({ id: "b", orderName: "#2", destination: "Girona, ES", status: "accepted" }),
    row({ id: "c", orderName: "#3", destination: "Dubrovnik, HR", status: "escalated" }),
  ];
  assert.deepEqual(
    applyControlFilters(rows, { destination: "Girona, ES", status: ["Escalated"] }, NOW).map((r) => r.id),
    ["a"]
  );
});

test("options come from the rows on screen and are de-duplicated", () => {
  const rows = [
    row({ destination: "Girona, ES", status: "escalated" }),
    row({ id: "b", destination: "Girona, ES", status: "accepted" }),
    row({ id: "c", destination: "Dubrovnik, HR", status: "escalated" }),
  ];
  assert.deepEqual(destinationOptions(rows), ["Dubrovnik, HR", "Girona, ES"]);
  assert.deepEqual(statusOptions(rows, NOW), ["Accepted", "Escalated"]);
});

test("a destination we could not derive is not offered as an option", () => {
  assert.deepEqual(destinationOptions([row({ destination: "—" }), row({ id: "b", destination: "" })]), []);
});

test("activeFilterCount counts only filters that narrow the list", () => {
  assert.equal(activeFilterCount({}), 0);
  assert.equal(activeFilterCount({ order: "  ", status: [] }), 0);
  assert.equal(activeFilterCount({ order: "#3", destination: "Girona, ES" }), 2);
  assert.equal(activeFilterCount({ status: ["Escalated"], from: "2026-09-03", to: "2026-09-03" }), 3);
});
