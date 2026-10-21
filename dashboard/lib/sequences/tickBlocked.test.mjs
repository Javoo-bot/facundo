// Sanity assertions for the tick's "why did nothing happen" reasons. Run with:
//   node --test lib/sequences/tickBlocked.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  TICK_BLOCKED_REASONS,
  TICK_BLOCKED_COPY,
  isTickBlockedReason,
  tickBlockedCopy,
} from "./tickBlocked.ts";

test("every reason has copy — a new one cannot ship silently", () => {
  // The drift this guards: add a reason to the engine, forget the sentence, and
  // the log falls back to raw JSON at exactly the moment someone is trying to
  // work out why no email arrived.
  for (const reason of TICK_BLOCKED_REASONS) {
    const copy = TICK_BLOCKED_COPY[reason];
    assert.ok(copy, `no copy for "${reason}"`);
    assert.ok(copy.length > 20, `copy for "${reason}" is too terse to help`);
  }
  assert.equal(Object.keys(TICK_BLOCKED_COPY).length, TICK_BLOCKED_REASONS.length);
});

test("every reason names a fix, not just a symptom", () => {
  // "disabled" restates what the user already knows. Each sentence has to say
  // where to go — either a settings location or what actually broke.
  for (const reason of TICK_BLOCKED_REASONS) {
    const copy = TICK_BLOCKED_COPY[reason];
    assert.ok(
      copy.includes("Settings") || copy.includes("could not be read"),
      `copy for "${reason}" doesn't tell anyone what to do: ${copy}`,
    );
  }
});

test("the switch reason points at the tab that actually holds the switch", () => {
  // It moved once already (there was no such tab until the Outreach panel
  // shipped); a wrong signpost is worse than none.
  assert.match(TICK_BLOCKED_COPY["sequence-disabled"], /Settings → Outreach/);
});

test("an unknown or absent reason yields no sentence, so the caller can fall back", () => {
  assert.equal(tickBlockedCopy(undefined), null);
  assert.equal(tickBlockedCopy(null), null);
  assert.equal(tickBlockedCopy("something-new"), null);
  assert.equal(tickBlockedCopy(42), null);
  // A tick that genuinely ran reports blocked: null — that must not print as an
  // explanation for silence.
  assert.equal(tickBlockedCopy(""), null);
});

test("isTickBlockedReason narrows what arrives over JSON", () => {
  assert.equal(isTickBlockedReason("sequence-disabled"), true);
  assert.equal(isTickBlockedReason("SEQUENCE-DISABLED"), false);
  assert.equal(isTickBlockedReason({}), false);
});
