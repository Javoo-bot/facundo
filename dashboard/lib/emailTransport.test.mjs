import test from "node:test";
import assert from "node:assert/strict";
import { resolveEmailTransport, emailTransportError } from "./emailTransport.ts";

const ONGAGE_OK = {
  ONGAGE_LIST_ID: "1",
  ONGAGE_USERNAME: "u",
  ONGAGE_PASSWORD: "p",
  ONGAGE_ACCOUNT_CODE: "c",
  ONGAGE_SENDING_CONNECTION_ID: "42",
};

test("unset EMAIL_TRANSPORT: resolves to null and fails closed with a clear reason", () => {
  assert.equal(resolveEmailTransport({}), null);
  assert.match(emailTransportError({}), /EMAIL_TRANSPORT must be set to "resend" or "ongage"/);
  assert.match(emailTransportError({}), /got null/);
});

test("EMAIL_TRANSPORT set to something other than resend/ongage: null, names the bad value", () => {
  assert.equal(resolveEmailTransport({ EMAIL_TRANSPORT: "sendgrid" }), null);
  assert.match(emailTransportError({ EMAIL_TRANSPORT: "sendgrid" }), /got "sendgrid"/);
});

test('EMAIL_TRANSPORT="resend" without RESEND_API_KEY: null, fails closed (never falls back to ongage)', () => {
  const env = { EMAIL_TRANSPORT: "resend", ...ONGAGE_OK }; // ongage fully configured too — must NOT be used
  assert.equal(resolveEmailTransport(env), null);
  assert.equal(emailTransportError(env), "EMAIL_TRANSPORT=resend but RESEND_API_KEY is not set");
});

test('EMAIL_TRANSPORT="resend" with RESEND_API_KEY: resolves to "resend"', () => {
  assert.equal(resolveEmailTransport({ EMAIL_TRANSPORT: "resend", RESEND_API_KEY: "re_test" }), "resend");
});

test('EMAIL_TRANSPORT="ongage" without ongageConfig() succeeding: null for each missing var, fails closed (never falls back to resend)', () => {
  const keys = Object.keys(ONGAGE_OK);
  for (const missing of keys) {
    const env = { EMAIL_TRANSPORT: "ongage", RESEND_API_KEY: "re_test", ...ONGAGE_OK, [missing]: undefined };
    assert.equal(resolveEmailTransport(env), null, `missing ${missing} must fail closed`);
    assert.match(emailTransportError(env), /EMAIL_TRANSPORT=ongage but Ongage is not configured/);
  }
});

test('EMAIL_TRANSPORT="ongage" with a non-numeric or non-positive connection id: null', () => {
  for (const bad of ["abc", "0", "-1", ""]) {
    const env = { EMAIL_TRANSPORT: "ongage", ...ONGAGE_OK, ONGAGE_SENDING_CONNECTION_ID: bad };
    assert.equal(resolveEmailTransport(env), null, `connection id ${JSON.stringify(bad)} must fail closed`);
  }
});

test('EMAIL_TRANSPORT="ongage" with every var present: resolves to "ongage"', () => {
  assert.equal(resolveEmailTransport({ EMAIL_TRANSPORT: "ongage", ...ONGAGE_OK }), "ongage");
});

test("whitespace around EMAIL_TRANSPORT is tolerated (trimmed), but whitespace-only is not a value", () => {
  assert.equal(resolveEmailTransport({ EMAIL_TRANSPORT: " resend ", RESEND_API_KEY: "re_test" }), "resend");
  assert.equal(resolveEmailTransport({ EMAIL_TRANSPORT: "   " }), null);
});

test("falls back to process.env when no env object is passed", () => {
  const saved = { t: process.env.EMAIL_TRANSPORT, k: process.env.RESEND_API_KEY };
  try {
    process.env.EMAIL_TRANSPORT = "resend";
    process.env.RESEND_API_KEY = "re_test";
    assert.equal(resolveEmailTransport(), "resend");
    delete process.env.RESEND_API_KEY;
    assert.equal(resolveEmailTransport(), null);
  } finally {
    for (const [k, v] of [["EMAIL_TRANSPORT", saved.t], ["RESEND_API_KEY", saved.k]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
