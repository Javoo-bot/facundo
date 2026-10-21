import test from "node:test";
import assert from "node:assert/strict";
import { orderWorkingSetDecision } from "./workingSetDecision.ts";

function fakeOrdersClient(row, error = null) {
  return {
    from(table) {
      assert.equal(table, "orders");
      return {
        select() { return this; },
        eq() { return this; },
        is() { return this; },
        async maybeSingle() {
          return { data: row, error };
        },
      };
    },
  };
}

test("orderWorkingSetDecision excludes an order outside an active explicit-pick gate", async () => {
  const cfg = { activeTags: [], activeCountries: [], runAllOrders: false, anyExplicitPicks: true };
  const sb = fakeOrdersClient({ tags: null, worklist_at: null });
  const seen = [];
  const decision = await orderWorkingSetDecision(sb, "o1", cfg, "test", (_ctx, e) => seen.push(e));
  assert.equal(decision, "out");
  assert.equal(seen.length, 0);
});

test("orderWorkingSetDecision admits an explicit pick", async () => {
  const cfg = { activeTags: [], activeCountries: [], runAllOrders: false, anyExplicitPicks: true };
  const sb = fakeOrdersClient({ tags: null, worklist_at: "2026-08-13T00:00:00Z" });
  const decision = await orderWorkingSetDecision(sb, "o1", cfg, "test", () => {});
  assert.equal(decision, "in");
});

test("orderWorkingSetDecision captures read failures and fails open", async () => {
  const cfg = { activeTags: [], activeCountries: [], runAllOrders: false, anyExplicitPicks: true };
  const sb = fakeOrdersClient(null, new Error("db down"));
  const seen = [];
  const decision = await orderWorkingSetDecision(sb, "o1", cfg, "test", (_ctx, e) => seen.push(e));
  assert.equal(decision, "fail-open");
  assert.equal(seen.length, 1);
});
