import test from "node:test";
import assert from "node:assert/strict";
import { buildLoginFailureRow, DETAIL_MAX } from "./loginFailures.ts";

// The row builder is the only pure part of the failure log, and it decides what
// a failed login actually looks like when someone comes to query it. The rules
// worth pinning: "unknown" is always null (never ""), the email is comparable
// against allowed_emails, and one long provider message can't bloat the table.

test("the diagnostic fields survive intact", () => {
  const row = buildLoginFailureRow({
    stage: "code_exchange",
    reason: "pkce_code_verifier_not_found",
    detail: "PKCE code verifier not found in storage.",
    host: "bo.fc.example.net",
    nextParam: "/auth/reset",
    userAgent: "Mozilla/5.0 (Linux; Android 14) GoogleChat/2024",
  });
  assert.equal(row.stage, "code_exchange");
  assert.equal(row.reason, "pkce_code_verifier_not_found");
  assert.equal(row.host, "bo.fc.example.net");
  // The field that separates an expired password reset from a failed sign-in.
  assert.equal(row.next_param, "/auth/reset");
  // The field that names an in-app browser.
  assert.match(row.user_agent, /GoogleChat/);
});

test("unknown is null, never an empty string, so one value means one thing", () => {
  const row = buildLoginFailureRow({ stage: "no_code", reason: "", detail: "   ", host: null, userAgent: undefined });
  assert.equal(row.reason, null);
  assert.equal(row.detail, null);
  assert.equal(row.host, null);
  assert.equal(row.user_agent, null);
  assert.equal(row.next_param, null);
  assert.equal(row.user_email, null);
});

test("the email is lowercased so it joins against allowed_emails", () => {
  const row = buildLoginFailureRow({ stage: "not_allowed", userEmail: "  Staff+Staff@fc.example.com " });
  assert.equal(row.user_email, "staff+staff@fc.example.com");
});

test("a long provider message is capped rather than stored whole", () => {
  const row = buildLoginFailureRow({ stage: "code_exchange", detail: "x".repeat(DETAIL_MAX + 250) });
  assert.equal(row.detail.length, DETAIL_MAX);
});
