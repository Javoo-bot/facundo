import { test } from "node:test";
import assert from "node:assert/strict";
import { isFulfilmentSlaBreached } from "./fulfilmentBreach.ts";

const NOW = Date.parse("2026-07-15T12:00:00Z");

test("not breached when neither signal has fired", () => {
  assert.equal(
    isFulfilmentSlaBreached({
      slaDeadlineAt: "2026-07-15T14:00:00Z", // 2h from now
      deliveryAt: "2026-07-15T16:00:00Z", // 4h from now
      hasProgress: false,
      nowMs: NOW,
    }),
    false,
  );
});

test("breached once sla_deadline_at has passed", () => {
  assert.equal(
    isFulfilmentSlaBreached({
      slaDeadlineAt: "2026-07-15T11:59:00Z", // 1 minute ago
      deliveryAt: "2026-07-15T16:00:00Z",
      hasProgress: false,
      nowMs: NOW,
    }),
    true,
  );
});

test("breached within the delivery buffer even if sla_deadline_at is null", () => {
  assert.equal(
    isFulfilmentSlaBreached({
      slaDeadlineAt: null,
      deliveryAt: "2026-07-15T12:30:00Z", // 30 min from now, inside the 1h buffer
      hasProgress: false,
      nowMs: NOW,
    }),
    true,
  );
});

test("not breached when delivery is well outside the buffer and sla_deadline_at is null", () => {
  assert.equal(
    isFulfilmentSlaBreached({
      slaDeadlineAt: null,
      deliveryAt: "2026-07-15T20:00:00Z",
      hasProgress: false,
      nowMs: NOW,
    }),
    false,
  );
});

test("never breached once there's real progress, even if both deadlines passed", () => {
  assert.equal(
    isFulfilmentSlaBreached({
      slaDeadlineAt: "2026-07-15T00:00:00Z",
      deliveryAt: "2026-07-15T01:00:00Z",
      hasProgress: true,
      nowMs: NOW,
    }),
    false,
  );
});

test("both signals null never breaches (no evidence, no false positive)", () => {
  assert.equal(
    isFulfilmentSlaBreached({ slaDeadlineAt: null, deliveryAt: null, hasProgress: false, nowMs: NOW }),
    false,
  );
});

test("a custom buffer is honoured", () => {
  assert.equal(
    isFulfilmentSlaBreached({
      slaDeadlineAt: null,
      deliveryAt: "2026-07-15T12:20:00Z", // 20 min out
      hasProgress: false,
      nowMs: NOW,
      bufferMs: 10 * 60 * 1000, // 10 min buffer — 20 min out is still safe
    }),
    false,
  );
});
