import test from "node:test";
import assert from "node:assert/strict";
import {
  recordingDecision,
  mayRecordAudioIn,
  retainUntil,
  isPurgeDue,
} from "./recordingPolicy.ts";

const NOW = Date.parse("2026-08-08T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const ON = { voice_record_audio: true, voice_transcribe: true, voice_retention_days: 90 };

// THE INVARIANT. Recording a call is lawful here when both parties are notified,
// so the one state this module must never produce is capture without a notice.
test("nothing is ever captured without a notice covering it", () => {
  const cases = [
    [ON, "ES"], [ON, "DE"], [ON, null],
    [{ voice_record_audio: false, voice_transcribe: true }, "FR"],
    [{ voice_record_audio: true, voice_transcribe: false }, "IT"],
    [{}, "PT"], [null, "ES"], [undefined, null],
    [{ voice_record_audio: true, voice_record_by_country: { DE: false } }, "DE"],
  ];
  for (const [settings, country] of cases) {
    const d = recordingDecision(settings, country);
    if (d.recordAudio) {
      assert.ok(d.noticeParts.includes("recording"), `audio without a recording notice: ${JSON.stringify([settings, country])}`);
    }
    if (d.transcribe && !d.recordAudio) {
      assert.ok(d.noticeParts.includes("transcript"), `transcript without a notice: ${JSON.stringify([settings, country])}`);
    }
  }
});

// Independent of whether anything is stored — that is the standing voice policy
// and the AI Act obligation does not turn on recording.
test("the AI disclosure is always in the notice", () => {
  for (const settings of [ON, { voice_record_audio: false, voice_transcribe: false }, {}, null]) {
    assert.ok(recordingDecision(settings, "ES").noticeParts.includes("ai"), JSON.stringify(settings));
  }
});

test("audio on means an audio notice; the transcript notice is not doubled up", () => {
  const d = recordingDecision(ON, "ES");
  assert.equal(d.recordAudio, true);
  assert.deepEqual(d.noticeParts, ["ai", "recording"]);
});

test("transcript only says so, without claiming a recording", () => {
  const d = recordingDecision({ voice_record_audio: false, voice_transcribe: true }, "ES");
  assert.equal(d.recordAudio, false);
  assert.equal(d.transcribe, true);
  assert.deepEqual(d.noticeParts, ["ai", "transcript"]);
});

// ---- the per-country override ----

test("a market can be switched off without stopping calls elsewhere", () => {
  const s = { voice_record_audio: true, voice_record_by_country: { DE: false } };
  assert.equal(mayRecordAudioIn(s, "DE"), false);
  assert.equal(mayRecordAudioIn(s, "ES"), true);
});

test("a market can be switched on while the global default is off", () => {
  const s = { voice_record_audio: false, voice_record_by_country: { ES: true } };
  assert.equal(mayRecordAudioIn(s, "ES"), true);
  assert.equal(mayRecordAudioIn(s, "DE"), false);
});

test("country matching ignores case and padding", () => {
  const s = { voice_record_audio: false, voice_record_by_country: { ES: true } };
  assert.equal(mayRecordAudioIn(s, " es "), true);
});

// Anything we cannot read is treated as "do not record" — the direction a
// regulator would expect a system to fail in.
test("an unusable override never turns recording on", () => {
  for (const map of ["nope", ["ES"], { ES: "yes" }, { ES: 1 }, { ES: null }]) {
    assert.equal(mayRecordAudioIn({ voice_record_audio: false, voice_record_by_country: map }, "ES"), false, JSON.stringify(map));
  }
});

test("an override entry that isn't exactly true does not record, even globally on", () => {
  assert.equal(mayRecordAudioIn({ voice_record_audio: true, voice_record_by_country: { ES: "true" } }, "ES"), false);
});

// ---- retention ----

test("retention is stamped at call time from the current policy", () => {
  const d = recordingDecision({ ...ON, voice_retention_days: 30 }, "ES");
  assert.equal(d.retentionDays, 30);
  assert.equal(retainUntil(d, NOW), new Date(NOW + 30 * DAY).toISOString());
});

// "Forever" is never a defensible answer for a recording of somebody's voice.
test("retention is clamped to something defensible", () => {
  assert.equal(recordingDecision({ ...ON, voice_retention_days: 0 }, "ES").retentionDays, 1);
  assert.equal(recordingDecision({ ...ON, voice_retention_days: -5 }, "ES").retentionDays, 1);
  assert.equal(recordingDecision({ ...ON, voice_retention_days: 100000 }, "ES").retentionDays, 365);
  assert.equal(recordingDecision({ ...ON, voice_retention_days: "nonsense" }, "ES").retentionDays, 90);
  assert.equal(recordingDecision({ ...ON, voice_retention_days: null }, "ES").retentionDays, 90);
  assert.equal(recordingDecision({ ...ON, voice_retention_days: undefined }, "ES").retentionDays, 90);
  assert.equal(recordingDecision({ ...ON, voice_retention_days: "" }, "ES").retentionDays, 90);
});

// The trap this guards: Number(null) and Number("") are both 0, and 0 clamps to
// one day — so an UNSET retention setting would delete every recording tomorrow.
// Silent, and the opposite of what "unset" means.
test("an unset retention never means 'delete tomorrow'", () => {
  for (const v of [null, undefined, ""]) {
    const days = recordingDecision({ ...ON, voice_retention_days: v }, "ES").retentionDays;
    assert.equal(days, 90, `${JSON.stringify(v)} resolved to ${days} days`);
  }
  // An explicit 0 IS a deliberate instruction, and clamps to the floor.
  assert.equal(recordingDecision({ ...ON, voice_retention_days: 0 }, "ES").retentionDays, 1);
});

test("a call is due for purging once its deadline passes, and only once", () => {
  assert.equal(isPurgeDue({ retain_until: new Date(NOW - 1).toISOString() }, NOW), true);
  assert.equal(isPurgeDue({ retain_until: new Date(NOW + DAY).toISOString() }, NOW), false);
  assert.equal(
    isPurgeDue({ retain_until: new Date(NOW - DAY).toISOString(), purged_at: new Date(NOW).toISOString() }, NOW),
    false,
    "already purged"
  );
});

test("a call with no deadline is never purged by accident", () => {
  assert.equal(isPurgeDue({}, NOW), false);
  assert.equal(isPurgeDue({ retain_until: null }, NOW), false);
  assert.equal(isPurgeDue({ retain_until: "not a date" }, NOW), false);
});
