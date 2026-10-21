import test from "node:test";
import assert from "node:assert/strict";
import { airwallexCardUrl, airwallexCardTransactionsUrl, isDemoAirwallexBase } from "./links.ts";

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test("card url: verified sandbox path /app/cards/card-details/{id}", () => {
  withEnv({ AIRWALLEX_BASE: "https://api-demo.airwallex.com", AIRWALLEX_APP_BASE: undefined }, () => {
    assert.equal(airwallexCardUrl("c_123"), "https://demo.airwallex.com/app/cards/card-details/c_123");
  });
});

test("card url: production host", () => {
  withEnv({ AIRWALLEX_BASE: "https://api.airwallex.com", AIRWALLEX_APP_BASE: undefined }, () => {
    assert.equal(airwallexCardUrl("c_1"), "https://www.airwallex.com/app/cards/card-details/c_1");
  });
});

test("card url: null/empty id -> null", () => {
  assert.equal(airwallexCardUrl(null), null);
  assert.equal(airwallexCardUrl(undefined), null);
  assert.equal(airwallexCardUrl(""), null);
});

test("card url: id is URL-encoded", () => {
  withEnv({ AIRWALLEX_BASE: "https://api-demo.airwallex.com", AIRWALLEX_APP_BASE: undefined }, () => {
    assert.equal(airwallexCardUrl("a/b"), "https://demo.airwallex.com/app/cards/card-details/a%2Fb");
  });
});

test("AIRWALLEX_APP_BASE overrides and trailing slash trimmed", () => {
  withEnv({ AIRWALLEX_APP_BASE: "https://console.example.com/" }, () => {
    assert.equal(airwallexCardUrl("c_1"), "https://console.example.com/app/cards/card-details/c_1");
  });
});

test("transactions url: card-transactions list", () => {
  withEnv({ AIRWALLEX_BASE: "https://api-demo.airwallex.com", AIRWALLEX_APP_BASE: undefined }, () => {
    assert.equal(airwallexCardTransactionsUrl(), "https://demo.airwallex.com/app/cards/transactions");
  });
  withEnv({ AIRWALLEX_BASE: "https://api.airwallex.com", AIRWALLEX_APP_BASE: undefined }, () => {
    assert.equal(airwallexCardTransactionsUrl(), "https://www.airwallex.com/app/cards/transactions");
  });
});

test("isDemoAirwallexBase detects demo API and console hosts", () => {
  assert.equal(isDemoAirwallexBase("https://api-demo.airwallex.com"), true);
  assert.equal(isDemoAirwallexBase("https://demo.airwallex.com"), true);
  assert.equal(isDemoAirwallexBase("https://api.airwallex.com"), false);
});

test("defaults to sandbox host when no env set", () => {
  withEnv({ AIRWALLEX_BASE: undefined, AIRWALLEX_APP_BASE: undefined }, () => {
    assert.equal(airwallexCardUrl("c_1"), "https://demo.airwallex.com/app/cards/card-details/c_1");
  });
});
