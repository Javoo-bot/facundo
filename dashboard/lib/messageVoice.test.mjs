import test from "node:test";
import assert from "node:assert/strict";
import { voiceForKind, resolveVoice, resolveVoiceFor, isEmailVoice, DEFAULT_VOICE } from "./messageVoice.ts";

test("the default is branded — the way every email already looks", () => {
  assert.equal(DEFAULT_VOICE, "branded");
});

test("a configured kind resolves to its voice", () => {
  const s = { message_voice: { "recruit.t2": "plain", "recruit.t1": "branded" } };
  assert.equal(voiceForKind(s, "recruit.t2"), "plain");
  assert.equal(voiceForKind(s, "recruit.t1"), "branded");
});

// Fail-open: a settings read that goes wrong must not silently restyle the
// company's mail. Every one of these is a real shape we can be handed.
test("anything unusable falls back to branded, never throws", () => {
  const cases = [
    null,
    undefined,
    {},
    { message_voice: null },
    { message_voice: undefined },
    { message_voice: "plain" },        // a string, not a map
    { message_voice: ["plain"] },      // an array
    { message_voice: { offer: "PLAIN" } },  // wrong case
    { message_voice: { offer: "fancy" } },  // typo in a hand-edited row
    { message_voice: { offer: null } },
    { message_voice: { offer: 1 } },
  ];
  for (const s of cases) {
    assert.equal(voiceForKind(s, "offer"), "branded", `resolved non-branded from ${JSON.stringify(s)}`);
  }
});

test("an unconfigured kind falls back to branded", () => {
  assert.equal(voiceForKind({ message_voice: { "recruit.t2": "plain" } }, "offer"), "branded");
});

test("a step override wins over the per-kind default, both ways", () => {
  assert.equal(resolveVoice("plain", "branded"), "plain");
  assert.equal(resolveVoice("branded", "plain"), "branded");
});

// A step with no opinion must not undo a deliberate per-kind setting.
test("an absent or invalid step override leaves the per-kind default intact", () => {
  for (const stepVoice of [undefined, null, "", "fancy", 0, {}]) {
    assert.equal(resolveVoice(stepVoice, "plain"), "plain", `clobbered by ${JSON.stringify(stepVoice)}`);
    assert.equal(resolveVoice(stepVoice, "branded"), "branded");
  }
});

test("resolveVoiceFor composes both levels", () => {
  const s = { message_voice: { "recruit.t2": "plain" } };
  assert.equal(resolveVoiceFor(s, "recruit.t2"), "plain");
  assert.equal(resolveVoiceFor(s, "recruit.t2", "branded"), "branded");
  assert.equal(resolveVoiceFor(s, "offer"), "branded");
  assert.equal(resolveVoiceFor(null, "offer", "plain"), "plain");
});

test("isEmailVoice is strict", () => {
  assert.ok(isEmailVoice("branded"));
  assert.ok(isEmailVoice("plain"));
  for (const x of ["Plain", "", null, undefined, 1, {}]) assert.ok(!isEmailVoice(x), String(x));
});
