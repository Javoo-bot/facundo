import { describe, it, expect } from "vitest";
import { shopifyLifecycle, orderClosure } from "../src/shopifyLifecycle";

describe("shopifyLifecycle", () => {
  it("reads fulfilled, archived and cancelled off the raw payload", () => {
    expect(shopifyLifecycle({ fulfillment_status: "fulfilled" })).toEqual({
      fulfilled: true, archived: false, cancelled: false,
    });
    // Shopify's archive IS closed_at — there is no separate "archived" field.
    expect(shopifyLifecycle({ closed_at: "2026-08-03T15:00:00Z" })).toEqual({
      fulfilled: false, archived: true, cancelled: false,
    });
    expect(shopifyLifecycle({ cancelled_at: "2026-08-03T15:00:00Z" })).toEqual({
      fulfilled: false, archived: false, cancelled: true,
    });
  });

  it("treats an unfulfilled / partially fulfilled order as not fulfilled", () => {
    expect(shopifyLifecycle({ fulfillment_status: null }).fulfilled).toBe(false);
    expect(shopifyLifecycle({ fulfillment_status: "partial" }).fulfilled).toBe(false);
    expect(shopifyLifecycle({ fulfillment_status: "restocked" }).fulfilled).toBe(false);
  });

  it("never throws on a malformed or empty payload", () => {
    for (const raw of [null, undefined, 42, "nope", {}, { closed_at: "" }]) {
      expect(shopifyLifecycle(raw)).toEqual({ fulfilled: false, archived: false, cancelled: false });
    }
  });
});

describe("orderClosure", () => {
  const live = { fulfilled: false, archived: false, cancelled: false };
  const done = { fulfilled: true, archived: false, cancelled: false };
  const archived = { fulfilled: false, archived: true, cancelled: false };

  it("does nothing while Shopify still considers the order open", () => {
    expect(orderClosure(live, "received", false)).toEqual({ kind: "none" });
    expect(orderClosure(live, "accepted", true)).toEqual({ kind: "none" });
  });

  it("closes an order fulfilled or archived outside our loop", () => {
    expect(orderClosure(done, "received", false)).toEqual({ kind: "close", to: "closed" });
    expect(orderClosure(archived, "received", false)).toEqual({ kind: "close", to: "closed" });
    expect(orderClosure(done, "escalated", false)).toEqual({ kind: "close", to: "closed" });
    expect(orderClosure(done, "reaching_out", false)).toEqual({ kind: "close", to: "closed" });
  });

  it("flags a conflict rather than closing over a florist mid-delivery", () => {
    expect(orderClosure(done, "accepted", true)).toEqual({ kind: "conflict" });
    expect(orderClosure(archived, "in_production", true)).toEqual({ kind: "conflict" });
  });

  // The local-florist rail marks the Shopify order fulfilled at ACCEPT, so
  // "fulfilled + florist in flight" is its normal state rather than a
  // disagreement. Without the weFulfilled branch every accepted florist order
  // would raise a CX-desk conflict within one reconcile tick.
  it("is not a conflict when WE fulfilled it and a florist is still working", () => {
    expect(orderClosure(done, "accepted", true, true)).toEqual({ kind: "none" });
    expect(orderClosure(done, "in_production", true, true)).toEqual({ kind: "none" });
  });

  it("still conflicts when we did NOT fulfil it — the default is unchanged", () => {
    expect(orderClosure(done, "accepted", true, false)).toEqual({ kind: "conflict" });
    // omitting the argument entirely must behave exactly like `false`
    expect(orderClosure(done, "accepted", true)).toEqual({ kind: "conflict" });
  });

  it("archived is STILL a conflict even when we fulfilled — that is a human in the admin", () => {
    expect(orderClosure(archived, "accepted", true, true)).toEqual({ kind: "conflict" });
    expect(orderClosure({ ...done, archived: true }, "accepted", true, true)).toEqual({ kind: "conflict" });
  });

  it("weFulfilled does not keep a cancelled order open", () => {
    expect(orderClosure({ ...done, cancelled: true }, "accepted", true, true)).toEqual({
      kind: "close",
      to: "cancelled",
    });
  });

  it("weFulfilled with no florist in flight still closes — nothing left to protect", () => {
    expect(orderClosure(done, "received", false, true)).toEqual({ kind: "close", to: "closed" });
  });

  it("maps a Shopify cancellation onto our cancelled, even mid-flight", () => {
    // The orders/cancelled webhook owns the unwind; this is the backstop for a
    // dropped one, so it must win over the conflict branch.
    expect(orderClosure({ ...live, cancelled: true }, "received", false)).toEqual({ kind: "close", to: "cancelled" });
    expect(orderClosure({ ...done, cancelled: true }, "accepted", true)).toEqual({ kind: "close", to: "cancelled" });
  });

  it("is idempotent once we're already terminal", () => {
    for (const status of ["closed", "cancelled"]) {
      expect(orderClosure(done, status, false)).toEqual({ kind: "none" });
      expect(orderClosure(archived, status, false)).toEqual({ kind: "none" });
      expect(orderClosure({ ...live, cancelled: true }, status, false)).toEqual({ kind: "none" });
    }
  });

  it("closes a delivered-and-paid order we already worked — nothing is in flight any more", () => {
    // `delivered`/`paid` mean our florist finished; Shopify fulfilling then
    // archiving is the normal end of that story, not a conflict.
    expect(orderClosure(done, "paid", false)).toEqual({ kind: "close", to: "closed" });
  });
});
