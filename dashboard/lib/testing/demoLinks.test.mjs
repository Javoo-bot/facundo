import test from "node:test";
import assert from "node:assert/strict";
import { backofficeOrderPath, floristOrderPath, demoSplitViewPath, formatDemoIds } from "./demoLinks.ts";

test("backofficeOrderPath: builds /orders/<id>", () => {
  assert.equal(backofficeOrderPath("order-123"), "/orders/order-123");
});

test("backofficeOrderPath: blank/empty id falls back to the list page, never /orders/undefined", () => {
  for (const id of ["", "   "]) {
    assert.equal(backofficeOrderPath(id), "/orders", JSON.stringify(id));
  }
});

test("floristOrderPath: builds /florist/orders/<assignmentId>, mirroring orderDest()", () => {
  assert.equal(floristOrderPath("assign-1"), "/florist/orders/assign-1");
});

test("floristOrderPath: blank/empty id falls back rather than producing /florist/orders/undefined", () => {
  for (const id of ["", "   "]) {
    assert.equal(floristOrderPath(id), "/florist/orders", JSON.stringify(id));
  }
});

test("demoSplitViewPath: builds /testing/demo/<orderId>", () => {
  assert.equal(demoSplitViewPath("order-9"), "/testing/demo/order-9");
});

test("demoSplitViewPath: blank/empty id falls back to /testing rather than /testing/demo/undefined", () => {
  for (const id of ["", "   "]) {
    assert.equal(demoSplitViewPath(id), "/testing", JSON.stringify(id));
  }
});

test("formatDemoIds: all three ids present, one line each, in order", () => {
  const s = formatDemoIds({ orderId: "o1", floristId: "f1", assignmentId: "a1" });
  assert.equal(s, "order: o1\nflorist: f1\nassignment: a1");
});

test("formatDemoIds: null florist/assignment omit their lines entirely", () => {
  const s = formatDemoIds({ orderId: "o1", floristId: null, assignmentId: null });
  assert.equal(s, "order: o1");
});

test("formatDemoIds: table of omission combinations", () => {
  const cases = [
    { b: { orderId: "o1", floristId: "f1", assignmentId: null }, expect: "order: o1\nflorist: f1" },
    { b: { orderId: "o1", floristId: null, assignmentId: "a1" }, expect: "order: o1\nassignment: a1" },
    { b: { orderId: "", floristId: "f1", assignmentId: "a1" }, expect: "florist: f1\nassignment: a1" },
    { b: { orderId: "", floristId: null, assignmentId: null }, expect: "" },
  ];
  for (const c of cases) {
    assert.equal(formatDemoIds(c.b), c.expect, JSON.stringify(c.b));
  }
});
