import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Pure helpers only — the network/DB paths in shopifyFulfillment.ts are covered
// by the staging run against a real order, not here. Same split as
// shopifyTags.test.mjs vs shopifyWriteback.ts.
import {
  fulfillableOrders,
  userErrorMessage,
  toGid,
  readDryRunSignal,
} from "./fulfilmentRules.ts";

describe("fulfillableOrders", () => {

  test("keeps OPEN and IN_PROGRESS", () => {
    assert.deepEqual(
      fulfillableOrders([
        { id: "gid://shopify/FulfillmentOrder/1", status: "OPEN" },
        { id: "gid://shopify/FulfillmentOrder/2", status: "IN_PROGRESS" },
      ]),
      ["gid://shopify/FulfillmentOrder/1", "gid://shopify/FulfillmentOrder/2"]
    );
  });

  test("drops terminal states — sending one fails the whole mutation", () => {
    assert.deepEqual(
      fulfillableOrders([
        { id: "a", status: "CLOSED" },
        { id: "b", status: "CANCELLED" },
        { id: "c", status: "INCOMPLETE" },
        { id: "d", status: "OPEN" },
      ]),
      ["d"]
    );
  });

  test("case-insensitive on status", () => {
    assert.deepEqual(fulfillableOrders([{ id: "a", status: "open" }]), ["a"]);
  });

  test("unknown or missing status is NOT fulfillable", () => {
    assert.deepEqual(fulfillableOrders([{ id: "a" }, { id: "b", status: null }]), []);
  });

  test("tolerates null/undefined/empty without throwing", () => {
    assert.deepEqual(fulfillableOrders(null), []);
    assert.deepEqual(fulfillableOrders(undefined), []);
    assert.deepEqual(fulfillableOrders([]), []);
  });

  test("drops entries with no usable id", () => {
    assert.deepEqual(fulfillableOrders([{ id: "", status: "OPEN" }, { status: "OPEN" }]), []);
  });
});

describe("userErrorMessage", () => {

  test("null when Shopify reported no errors", () => {
    assert.equal(userErrorMessage([]), null);
    assert.equal(userErrorMessage(undefined), null);
    assert.equal(userErrorMessage(null), null);
  });

  test("joins field and message", () => {
    assert.equal(
      userErrorMessage([{ field: ["fulfillment", "lineItems"], message: "is invalid" }]),
      "fulfillment.lineItems: is invalid"
    );
  });

  test("joins multiple errors", () => {
    assert.equal(
      userErrorMessage([{ message: "one" }, { message: "two" }]),
      "one; two"
    );
  });

  test("survives a malformed error entry", () => {
    assert.equal(userErrorMessage([{}]), "unknown error");
    assert.equal(userErrorMessage([null]), "unknown error");
  });
});

describe("toGid", () => {

  test("wraps a bare numeric id as stored in orders.shopify_order_id", () => {
    assert.equal(toGid("Order", "1000000000001"), "gid://shopify/Order/1000000000001");
    assert.equal(toGid("Order", 1000000000001), "gid://shopify/Order/1000000000001");
  });

  test("leaves an existing gid alone — never double-wraps", () => {
    const gid = "gid://shopify/Fulfillment/123";
    assert.equal(toGid("Fulfillment", gid), gid);
  });
});


describe("readDryRunSignal", () => {
  test("an input complaint proves auth, scope and access all passed", () => {
    const r = readDryRunSignal(
      "fulfillment.lineItemsByFulfillmentOrder: Fulfillment payloads array size must be greater or equal to one."
    );
    assert.equal(r.wouldSucceed, true);
    assert.match(r.reason, /auth, scope and fulfillment-order access all passed/);
  });

  test("an access refusal means we are still blocked", () => {
    for (const msg of [
      "The api_client does not have access to the fulfillment order.",
      "Access denied",
      "You are not authorized to perform this action",
      "Missing permission",
    ]) {
      assert.equal(readDryRunSignal(msg).wouldSucceed, false, msg);
    }
  });

  test("no error at all is treated as UNPROVEN, not success", () => {
    // An empty fulfilment should never be accepted; if Shopify says nothing we
    // have learned nothing, and must not report a green light.
    for (const v of [null, undefined, ""]) {
      const r = readDryRunSignal(v);
      assert.equal(r.wouldSucceed, false);
      assert.match(r.reason, /unproven/);
    }
  });
});
