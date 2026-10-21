// Why a support thread ended up with a human. The reason string is the only
// diagnostic that reaches anyone without Cloudflare log access, so the cases we
// can tell apart have to say which they are.
//   node --test lib/agentTurn.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { llmUnavailable } from "./cxAgentGuard.ts";

test("a key, credit or limit problem is recognised as the account, not the reply", () => {
  // The one that prompted this: the dashboard Worker had ANTHROPIC_API_KEY and
  // never had OPENROUTER_API_KEY, so every draft went out with an empty
  // Authorization header.
  assert.equal(llmUnavailable(new Error("OpenRouter 401: no auth credentials found")), true);
  assert.equal(llmUnavailable(new Error("OpenRouter 402: insufficient credits")), true);
  // And the one waiting behind it — the key we do hold is over its weekly cap.
  assert.equal(
    llmUnavailable(new Error('OpenRouter 403: {"message":"Key limit exceeded (weekly limit)"}')),
    true
  );
  assert.equal(llmUnavailable(new Error("OpenRouter 429: rate limited")), true);
});

test("an ordinary bad turn is still just a bad turn", () => {
  // These want a prompt fix or a retry, not a billing page.
  assert.equal(llmUnavailable(new Error("agent did not call the tool")), false);
  assert.equal(llmUnavailable(new Error("OpenRouter 400: malformed request")), false);
  assert.equal(llmUnavailable(new Error("OpenRouter 500: upstream error")), false);
  assert.equal(llmUnavailable(new Error("support draft attempted with no facts")), false);
  assert.equal(llmUnavailable(null), false);
});
