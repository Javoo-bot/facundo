import test from "node:test";
import assert from "node:assert/strict";
import {
  refillDecision,
  escalationReasonLabel,
  escalationApprovalPreview,
  LEGACY_EXHAUSTED_REASON,
} from "./waveGuards.ts";

const NOW = Date.parse("2026-08-20T09:00:00.000Z");
const HOUR = 3_600_000;

// The shipped ladder (lib/reachout.ts::DEFAULT_OFFER_WINDOWS), so the cases
// below read as the real tiers rather than as arbitrary numbers.
const RUSH = 15, SAMEDAY = 30, STANDARD = 60, FAR = 120;

const at = (hoursFromNow) => new Date(NOW + hoursFromNow * HOUR).toISOString();

const guard = (over = {}) =>
  refillDecision({
    wavesSoFar: 1,
    maxWaves: 4,
    nextWindowMin: STANDARD,
    cxReserveHours: 2,
    deliveryAt: at(48),
    nowMs: NOW,
    ...over,
  });

test("refills while both guards have room", () => {
  assert.deepEqual(guard(), { refill: true });
});

test("stops at the wave ceiling", () => {
  assert.deepEqual(guard({ wavesSoFar: 4 }), { refill: false, reason: "wave_ceiling" });
  // Still refills on the wave BEFORE the ceiling — an off-by-one here would
  // silently cost a whole wave of florists.
  assert.deepEqual(guard({ wavesSoFar: 3 }), { refill: true });
});

test("a ceiling of 1 reproduces the pre-refill behavior", () => {
  assert.deepEqual(guard({ maxWaves: 1 }), { refill: false, reason: "wave_ceiling" });
});

test("a ceiling below 1 is floored, never 'offer nobody'", () => {
  // maxWaves 0 must not mean "don't even work the candidates we already have".
  assert.deepEqual(guard({ maxWaves: 0, wavesSoFar: 1 }), { refill: false, reason: "wave_ceiling" });
  assert.deepEqual(guard({ maxWaves: -5, wavesSoFar: 1 }), { refill: false, reason: "wave_ceiling" });
});

test("stops when the next window would eat into the CX reserve", () => {
  // Delivery in 2h30, standard 60min window, 2h reserve: the window would end
  // at T+1h, past the T+0h30 cutoff.
  assert.deepEqual(
    guard({ deliveryAt: at(2.5) }),
    { refill: false, reason: "out_of_time" }
  );
  // Same delivery, rush window (15min) — ends at T+0h15, inside the cutoff.
  assert.deepEqual(guard({ deliveryAt: at(2.5), nextWindowMin: RUSH }), { refill: true });
});

test("the reserve boundary is inclusive — a window landing exactly on it still runs", () => {
  // Delivery in 3h, 2h reserve, 60min window: the window ends exactly at the
  // cutoff, leaving CX exactly its 2h. The reserve is a guaranteed MINIMUM, so
  // honouring it precisely is allowed; one minute more is not.
  assert.deepEqual(guard({ deliveryAt: at(3) }), { refill: true });
  assert.deepEqual(guard({ deliveryAt: at(2.99) }), { refill: false, reason: "out_of_time" });
});

test("out_of_time wins over wave_ceiling when both apply", () => {
  // Reported reason drives what a human does next, and 'place it now' is the
  // one that can't wait.
  assert.deepEqual(
    guard({ wavesSoFar: 9, deliveryAt: at(1) }),
    { refill: false, reason: "out_of_time" }
  );
});

test("a zero reserve still refuses to run past the delivery moment", () => {
  assert.deepEqual(
    guard({ cxReserveHours: 0, deliveryAt: at(0.5), nextWindowMin: STANDARD }),
    { refill: false, reason: "out_of_time" }
  );
  assert.deepEqual(guard({ cxReserveHours: 0, deliveryAt: at(2), nextWindowMin: STANDARD }), { refill: true });
});

test("a negative reserve is clamped, not treated as extra time", () => {
  assert.deepEqual(
    guard({ cxReserveHours: -5, deliveryAt: at(0.5), nextWindowMin: STANDARD }),
    { refill: false, reason: "out_of_time" }
  );
});

test("no delivery date: the ceiling is the only bound", () => {
  assert.deepEqual(guard({ deliveryAt: null, wavesSoFar: 1 }), { refill: true });
  assert.deepEqual(guard({ deliveryAt: null, wavesSoFar: 4 }), { refill: false, reason: "wave_ceiling" });
});

test("an unparseable delivery date falls back to the ceiling, not to infinite time", () => {
  assert.deepEqual(guard({ deliveryAt: "not-a-date", wavesSoFar: 1 }), { refill: true });
  assert.deepEqual(guard({ deliveryAt: "not-a-date", wavesSoFar: 4 }), { refill: false, reason: "wave_ceiling" });
});

// The worked examples from the agreed design — these are the numbers on the
// paper, so a change to the guard that breaks one of them should fail here.
test("the agreed ladder: what stops each urgency tier", () => {
  // Beyond 72h (5 days out, 120min windows) — ceiling binds, never time.
  assert.deepEqual(guard({ deliveryAt: at(120), nextWindowMin: FAR, wavesSoFar: 3 }), { refill: true });
  assert.deepEqual(
    guard({ deliveryAt: at(120), nextWindowMin: FAR, wavesSoFar: 4 }),
    { refill: false, reason: "wave_ceiling" }
  );

  // Within 24h (20h out, 30min windows) — ceiling binds; escalates ~14h early.
  assert.deepEqual(guard({ deliveryAt: at(20), nextWindowMin: SAMEDAY, wavesSoFar: 3 }), { refill: true });

  // 3h out (rush, 15min) — time guard binds first: 3h − 2h reserve = 1h of
  // room, so a few more offers fit but the ceiling is never reached.
  assert.deepEqual(guard({ deliveryAt: at(3), nextWindowMin: RUSH, wavesSoFar: 1 }), { refill: true });
  assert.deepEqual(
    guard({ deliveryAt: at(2), nextWindowMin: RUSH, wavesSoFar: 1 }),
    { refill: false, reason: "out_of_time" }
  );
});

const ALL_REASONS = [
  "out_of_time",
  "wave_ceiling",
  "pool_exhausted",
  "candidates_exhausted",
  "past_delivery_deadline",
  "accept_sla_breach_no_candidates",
];

test("every reason has its own label, and unknown falls back", () => {
  const labels = ALL_REASONS.map(escalationReasonLabel);
  assert.equal(new Set(labels).size, ALL_REASONS.length, "each reason needs a distinct label — CX acts on the difference");
  assert.equal(escalationReasonLabel(null), "No florist found — escalated");
  assert.equal(escalationReasonLabel("something-new"), "No florist found — escalated");
});

test("pool_exhausted and the legacy reason read differently — they claim different things", () => {
  // pool_exhausted means a refill RAN and found nobody. The legacy value (still
  // written by semi/manual, and on every pre-refill row) means only that this
  // order's list ran out; nothing checked whether the city holds more shops.
  // Collapsing them would tell CX "no florist left in range" about an order
  // where nobody looked.
  assert.notEqual(escalationReasonLabel(LEGACY_EXHAUSTED_REASON), escalationReasonLabel("pool_exhausted"));
  assert.match(escalationReasonLabel("pool_exhausted"), /in range/);
  assert.doesNotMatch(escalationReasonLabel(LEGACY_EXHAUSTED_REASON), /in range/);
});

test("the approval preview is a full sentence per reason, never the bare label", () => {
  for (const reason of ALL_REASONS) {
    const preview = escalationApprovalPreview(reason);
    assert.match(preview, /\.$/, `${reason}: the approval preview should read as a sentence`);
    assert.notEqual(preview, escalationReasonLabel(reason));
  }
  // Unknown/null still produces something a human can act on rather than "".
  assert.match(escalationApprovalPreview(null), /hand to CX/i);
});
