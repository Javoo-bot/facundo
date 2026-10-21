import test from "node:test";
import assert from "node:assert/strict";
import { bucketOrdersByStatus, bucketDeclineReasons, bucketIssuesByType, bucketByDay } from "./opsStats.ts";

test("bucketOrdersByStatus counts each status", () => {
  const rows = [{ status: "delivered" }, { status: "delivered" }, { status: "cancelled" }];
  assert.deepEqual(bucketOrdersByStatus(rows), { delivered: 2, cancelled: 1 });
});

test("bucketOrdersByStatus returns empty object for no rows", () => {
  assert.deepEqual(bucketOrdersByStatus([]), {});
});

test("bucketDeclineReasons ignores null reasons", () => {
  const rows = [{ decline_reason: "Too busy" }, { decline_reason: null }, { decline_reason: "Too busy" }];
  assert.deepEqual(bucketDeclineReasons(rows), { "Too busy": 2 });
});

test("bucketIssuesByType counts each type", () => {
  const rows = [{ type: "wrong_address" }, { type: "wrong_address" }, { type: "other" }];
  assert.deepEqual(bucketIssuesByType(rows), { wrong_address: 2, other: 1 });
});

test("bucketByDay groups ISO timestamps by their date", () => {
  const rows = [{ occurred_at: "2026-08-01T10:00:00Z" }, { occurred_at: "2026-08-01T22:00:00Z" }, { occurred_at: "2026-08-02T01:00:00Z" }];
  assert.deepEqual(bucketByDay(rows, (r) => r.occurred_at), [
    { date: "2026-08-01", count: 2 },
    { date: "2026-08-02", count: 1 },
  ]);
});
