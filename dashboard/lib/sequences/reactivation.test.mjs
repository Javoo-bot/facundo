import test from "node:test";
import assert from "node:assert/strict";
import {
  reactivationKind,
  NEVER_ACCEPTED_AFTER_DAYS,
  DORMANT_AFTER_DAYS,
} from "./reactivation.ts";

const NOW = Date.parse("2026-08-08T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (d) => new Date(NOW - d * DAY).toISOString();

const c = (over = {}) => ({
  joined_at: ago(200),
  excluded_at: null,
  deleted_at: null,
  order_emails_opt_out: false,
  lastAcceptedAt: null,
  hasBeenOffered: true,
  ...over,
});

test("a florist who joined, was offered, and never accepted gets the A sequence", () => {
  assert.equal(reactivationKind(c(), NOW), "reactivate_never_accepted");
});

test("a florist who accepted long ago gets the dormant sequence", () => {
  assert.equal(reactivationKind(c({ lastAcceptedAt: ago(DORMANT_AFTER_DAYS + 1) }), NOW), "reactivate_dormant");
});

// The distinction the whole thing turns on: telling a shop that never delivered
// for us "it's been a while since your last order" is visibly wrong.
test("the two sequences are never confused", () => {
  assert.equal(reactivationKind(c({ lastAcceptedAt: null }), NOW), "reactivate_never_accepted");
  assert.equal(reactivationKind(c({ lastAcceptedAt: ago(365) }), NOW), "reactivate_dormant");
});

test("a recently active florist is left alone", () => {
  assert.equal(reactivationKind(c({ lastAcceptedAt: ago(DORMANT_AFTER_DAYS - 1) }), NOW), null);
  assert.equal(reactivationKind(c({ lastAcceptedAt: ago(1) }), NOW), null);
});

test("the dormancy boundary is inclusive", () => {
  assert.equal(reactivationKind(c({ lastAcceptedAt: ago(DORMANT_AFTER_DAYS) }), NOW), "reactivate_dormant");
});

test("someone who just joined is given time before being nudged", () => {
  assert.equal(reactivationKind(c({ joined_at: ago(NEVER_ACCEPTED_AFTER_DAYS - 1) }), NOW), null);
  assert.equal(reactivationKind(c({ joined_at: ago(NEVER_ACCEPTED_AFTER_DAYS) }), NOW), "reactivate_never_accepted");
});

// Asking "why haven't you taken an order?" of someone we never offered one to
// blames them for our own failure.
test("a florist we never offered anything to is not asked why they haven't accepted", () => {
  assert.equal(reactivationKind(c({ hasBeenOffered: false }), NOW), null);
});

test("shops outside the network, excluded, deleted or opted out are never touched", () => {
  assert.equal(reactivationKind(c({ joined_at: null }), NOW), null);
  assert.equal(reactivationKind(c({ excluded_at: ago(1) }), NOW), null);
  assert.equal(reactivationKind(c({ deleted_at: ago(1) }), NOW), null);
  assert.equal(reactivationKind(c({ order_emails_opt_out: true }), NOW), null);
});

test("unparseable or future dates yield no decision rather than a wrong one", () => {
  assert.equal(reactivationKind(c({ joined_at: "not a date" }), NOW), null);
  assert.equal(reactivationKind(c({ lastAcceptedAt: "not a date" }), NOW), null);
  assert.equal(reactivationKind(c({ joined_at: new Date(NOW + DAY).toISOString() }), NOW), null);
  assert.equal(reactivationKind(c({ lastAcceptedAt: new Date(NOW + DAY).toISOString() }), NOW), null);
});
