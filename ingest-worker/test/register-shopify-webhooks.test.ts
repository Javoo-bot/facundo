import { describe, expect, it } from "vitest";
import { planActions } from "../scripts/register-shopify-webhooks.mjs";

// A representative topic set for exercising planActions (which takes topics as a
// param) — not the script's live TOPICS list.
const TOPICS = ["orders/create", "orders/edited", "orders/cancelled"];
const URL = "https://facundo.example.com/webhooks/shopify";

describe("planActions (register-shopify-webhooks)", () => {
  it("plans a create for every topic when nothing is registered yet", () => {
    const plan = planActions([], TOPICS, URL);
    expect(plan).toEqual(TOPICS.map((topic) => ({ topic, kind: "create" })));
  });

  it("plans a skip when a topic is already registered at the target url", () => {
    const existing = [{ id: 1, topic: "orders/create", format: "json", address: URL }];
    const plan = planActions(existing, ["orders/create"], URL);
    expect(plan).toEqual([{ topic: "orders/create", kind: "skip", id: 1 }]);
  });

  it("plans a repoint when a topic is registered at a different url", () => {
    const existing = [{ id: 2, topic: "orders/edited", format: "json", address: "https://old.example.com/hook" }];
    const plan = planActions(existing, ["orders/edited"], URL);
    expect(plan).toEqual([
      { topic: "orders/edited", kind: "repoint", id: 2, from: "https://old.example.com/hook" },
    ]);
  });

  it("ignores subscriptions in a different format (e.g. xml) and still plans a create", () => {
    const existing = [{ id: 3, topic: "orders/create", format: "xml", address: URL }];
    const plan = planActions(existing, ["orders/create"], URL);
    expect(plan).toEqual([{ topic: "orders/create", kind: "create" }]);
  });

  it("handles a mix of all three outcomes across topics", () => {
    const existing = [
      { id: 10, topic: "orders/create", format: "json", address: URL },
      { id: 11, topic: "orders/edited", format: "json", address: "https://old.example.com/hook" },
    ];
    const plan = planActions(existing, TOPICS, URL);
    expect(plan).toEqual([
      { topic: "orders/create", kind: "skip", id: 10 },
      { topic: "orders/edited", kind: "repoint", id: 11, from: "https://old.example.com/hook" },
      { topic: "orders/cancelled", kind: "create" },
    ]);
  });
});
