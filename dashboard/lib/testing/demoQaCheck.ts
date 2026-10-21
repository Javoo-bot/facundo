// Verifies that a batch of demo orders (the array GET /api/testing/orders
// returns) actually covers every lib/testing/orderScenarios.ts preset with the
// status/assignment pattern that scenario promises — the pure "did setup_all
// actually land" check behind the manual QA runbook
// (docs/demo-control-room-qa-runbook.md).
//
// Pure and alias-free (relative imports only, no "@/") so plain `node --test`
// can reach it — same convention as lib/testing/orderScenarios.ts and
// lib/testing/demoSummary.ts. Never touches Supabase itself: callers fetch
// the orders (via the live API, or lib/testing/demoSandbox.ts::listDemoOrders
// directly) and hand the array in here.
//
// Matches an order back to its scenario by orders.status alone: every preset
// in ORDER_SCENARIOS leaves the order at a DIFFERENT orders.status (matched /
// escalated / reaching_out / accepted / paid / delivered) — see this file's
// own test for the invariant that keeps that true. When more than one demo
// order shares a status (e.g. setup_all was run twice), whichever comes first
// in the input wins — callers should pass orders newest-first, the order
// listDemoOrders() already returns them in.

import { ORDER_SCENARIOS, type OrderScenarioId } from "./orderScenarios.ts";

export interface DemoOrderAssignmentLike {
  status: string | null;
}

export interface DemoOrderLike {
  id: string;
  status: string | null;
  is_demo?: boolean | null;
  order_assignments?: DemoOrderAssignmentLike[] | null;
}

export interface ScenarioCoverageResult {
  scenarioId: OrderScenarioId;
  label: string;
  present: boolean;
  orderId: string | null;
  assignmentOk: boolean;
  issues: string[];
}

export interface ScenarioCoverageSummary {
  total: number;
  covered: number;
  missing: OrderScenarioId[];
  mismatched: OrderScenarioId[];
  ok: boolean;
}

/** One ScenarioCoverageResult per lib/testing/orderScenarios.ts preset, checked
 *  against whichever demo orders were actually passed in. Never throws: a
 *  missing/malformed orders array is treated as empty (every scenario reads as
 *  missing) rather than blowing up a QA script mid-run. Rows with
 *  `is_demo === false` are ignored — everything else (true, or the field
 *  simply absent, as when a caller trims the response down) counts. */
export function verifyScenarioCoverage(orders: DemoOrderLike[] | null | undefined): ScenarioCoverageResult[] {
  const list = Array.isArray(orders) ? orders.filter((o) => o && o.is_demo !== false) : [];

  return ORDER_SCENARIOS.map((scenario) => {
    const order = list.find((o) => o.status === scenario.orderStatus) ?? null;

    if (!order) {
      return {
        scenarioId: scenario.id,
        label: scenario.label,
        present: false,
        orderId: null,
        assignmentOk: false,
        issues: [`No demo order found with status "${scenario.orderStatus}".`],
      };
    }

    const assignments = Array.isArray(order.order_assignments) ? order.order_assignments : [];
    const issues: string[] = [];
    let assignmentOk: boolean;

    if (scenario.assignmentStatus === null) {
      assignmentOk = assignments.length === 0;
      if (!assignmentOk) {
        issues.push(`Expected no assignment, found ${assignments.length} (statuses: ${assignments.map((a) => a.status).join(", ")}).`);
      }
    } else {
      assignmentOk = assignments.some((a) => a.status === scenario.assignmentStatus);
      if (!assignmentOk) {
        const seen = assignments.map((a) => a.status).join(", ") || "none";
        issues.push(`Expected an assignment with status "${scenario.assignmentStatus}", found: ${seen}.`);
      }
    }

    return {
      scenarioId: scenario.id,
      label: scenario.label,
      present: true,
      orderId: order.id,
      assignmentOk,
      issues,
    };
  });
}

/** Rolls a verifyScenarioCoverage() array up into pass/fail counts — the shape
 *  the runbook's "did it all land" checklist and any QA script actually care
 *  about, same spirit as demoSummary.ts::summarizeScenarioRuns. */
export function summarizeScenarioCoverage(results: ScenarioCoverageResult[] | null | undefined): ScenarioCoverageSummary {
  const list = Array.isArray(results) ? results : [];
  const missing = list.filter((r) => !r.present).map((r) => r.scenarioId);
  const mismatched = list.filter((r) => r.present && !r.assignmentOk).map((r) => r.scenarioId);
  return {
    total: list.length,
    covered: list.length - missing.length - mismatched.length,
    missing,
    mismatched,
    ok: missing.length === 0 && mismatched.length === 0,
  };
}
