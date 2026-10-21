// Cupid/Concierge replies were going out as "Re: Re: …" (seen 2026-10-14,
// Secret Garden, PR #3 real-mail test) because this always prepended "Re: "
// regardless of what the incoming subject already carried.
//   node --test lib/replySubject.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { replySubject } from "./replySubject.ts";

test("does not double up Re: on a subject that already has it, any case", () => {
  assert.equal(replySubject("Re: Flowers for pickup"), "Re: Flowers for pickup");
  assert.equal(replySubject("RE: Flowers for pickup"), "RE: Flowers for pickup");
  assert.equal(replySubject("re: Flowers for pickup"), "re: Flowers for pickup");
});

test("adds Re: to a subject that doesn't have it yet", () => {
  assert.equal(replySubject("Flowers for pickup"), "Re: Flowers for pickup");
});

test("leaves a Fwd: prefix alone, just adding Re: in front like any other subject", () => {
  assert.equal(replySubject("Fwd: Flowers for pickup"), "Re: Fwd: Flowers for pickup");
});

test("passes through a missing subject", () => {
  assert.equal(replySubject(null), null);
  assert.equal(replySubject(undefined), null);
  assert.equal(replySubject(""), null);
});
