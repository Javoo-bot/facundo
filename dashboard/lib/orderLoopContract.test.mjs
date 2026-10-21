import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { PHASES, CROSS_CUTTING } from "./lifecycle.ts";

// SKELETON — a structural contract check, not a live end-to-end test.
//
// This asserts that the Production working-set order-loop — Shopify import →
// working-set selection → match → offer wave → accept/70% → photo/30% →
// writeback → central escalation on failure — still exists as named stages in
// lib/lifecycle.ts (the order-lifecycle map's single source of truth) and that
// the files claimed to implement each step are still on disk. It does NOT boot
// the dashboard or the worker, hit Shopify, or touch a real Supabase project —
// there is no test harness in this repo that stands up both builds together
// against a scratch database. Building that is real, separate work; see
// CLAUDE.md's "Two systems, one repo" section for the next-task pointer.
//
// If this test starts failing, either the contract drifted from the real loop
// (fix the CONTRACT below) or a stage got renamed/removed in lifecycle.ts
// without updating this file (fix lifecycle.ts per CLAUDE.md's "keep the
// order-lifecycle map current" rule, then mirror the rename here).

const CONTRACT = [
  {
    step: "Shopify import",
    phaseId: "intake",
    stageIds: ["webhook", "order-created", "intake-parse"],
    implementedBy: ["ingest-worker/src/shopify.ts", "ingest-worker/src/shopifyLifecycle.ts"],
  },
  {
    step: "Working-set selection",
    phaseId: null, // a cross-order gate, not a stage on the happy-path map
    stageIds: [],
    implementedBy: ["dashboard/lib/workingSet.ts", "dashboard/lib/workingSetServer.ts", "ingest-worker/src/workingSet.ts"],
  },
  {
    step: "Match",
    phaseId: "match",
    stageIds: ["geocode", "match"],
    implementedBy: ["ingest-worker/src/match.ts"],
  },
  {
    step: "Offer wave",
    phaseId: "reachout",
    stageIds: ["reachout-send"],
    implementedBy: ["ingest-worker/src/orderWorkflow.ts"],
  },
  {
    step: "Accept / 70%",
    phaseId: "reachout",
    stageIds: ["florist-accept"],
    implementedBy: ["ingest-worker/src/orderWorkflow.ts", "dashboard/lib/payoutHold.ts"],
  },
  {
    step: "Photo / 30%",
    phaseId: "fulfil",
    stageIds: ["deliver-photo", "payout-accept"],
    implementedBy: ["dashboard/lib/photoVerify", "dashboard/lib/airwallex"],
  },
  {
    step: "Writeback",
    phaseId: "settle",
    stageIds: ["writeback"],
    implementedBy: ["dashboard/lib/shopifyWriteback.ts"],
  },
  {
    step: "Central escalation on failure",
    phaseId: null, // cross-cutting, not one stage — see CROSS_CUTTING below
    stageIds: [],
    implementedBy: ["dashboard/lib/cxAttention.ts"],
  },
];

test("every contract step's phase and stage ids still exist in lifecycle.ts", () => {
  const phaseIds = new Set(PHASES.map((p) => p.id));
  for (const step of CONTRACT) {
    if (step.phaseId === null) continue;
    assert.ok(phaseIds.has(step.phaseId), `${step.step}: phase "${step.phaseId}" is missing from PHASES`);
    const phase = PHASES.find((p) => p.id === step.phaseId);
    const stageIds = new Set(phase.stages.map((s) => s.id));
    for (const id of step.stageIds) {
      assert.ok(stageIds.has(id), `${step.step}: stage "${id}" is missing from phase "${step.phaseId}"`);
    }
  }
});

test("the contract's phases run in the same order the happy path does", () => {
  const order = PHASES.map((p) => p.id);
  const stepsInOrder = CONTRACT.filter((s) => s.phaseId !== null).map((s) => s.phaseId);
  let lastIndex = -1;
  for (const phaseId of stepsInOrder) {
    const idx = order.indexOf(phaseId);
    assert.ok(idx >= lastIndex, `phase "${phaseId}" appears out of order relative to the happy path`);
    lastIndex = idx;
  }
});

test("every file the contract points to actually exists", () => {
  for (const step of CONTRACT) {
    for (const rel of step.implementedBy) {
      const path = new URL(`../../${rel}`, import.meta.url);
      assert.ok(existsSync(path), `${step.step}: "${rel}" does not exist — update the contract`);
    }
  }
});

test("central escalation has at least one named cross-cutting failure mode to point to", () => {
  // Not exhaustive — just proves CROSS_CUTTING isn't empty, so "central
  // escalation" resolves to something concrete rather than a vague promise.
  assert.ok(CROSS_CUTTING.length > 0);
  assert.ok(CROSS_CUTTING.some((b) => b.id === "x-cx-spof"), "expected the CX single-point-of-failure branch to still exist");
});
