import { test } from "node:test";
import assert from "node:assert/strict";
import { recordCall } from "./photoVerify/types.ts";

// Hawkeye's photo_verifications.ai_context and its Langfuse trace are built
// from these records, so a provider that throws must still leave one behind.

test("a successful call records what was sent, what came back and the usage", async () => {
  const calls = [];
  const out = await recordCall(calls, { name: "claude", model: "anthropic/claude-sonnet-5", input: ["[the delivery photo]", "check it"] }, async (note) => {
    note({ matched: true }, { input_tokens: 900, output_tokens: 50 });
    return "parsed";
  });
  assert.equal(out, "parsed");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, ["[the delivery photo]", "check it"]);
  assert.deepEqual(calls[0].output, { matched: true });
  assert.deepEqual(calls[0].usage, { input_tokens: 900, output_tokens: 50 });
  assert.equal(calls[0].error, null);
  assert.ok(calls[0].endedAt >= calls[0].startedAt);
});

test("a call that throws is recorded with its error and the error still propagates", async () => {
  const calls = [];
  await assert.rejects(
    recordCall(calls, { name: "gemini", model: "gemini-2.5-flash", input: "check it" }, async (note) => {
      note("not json", null);
      throw new Error("Unexpected token");
    }),
    /Unexpected token/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].output, "not json");
  assert.equal(calls[0].error, "Unexpected token");
});
