import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { setupOrderScenario, cleanupDemoSandbox, listDemoOrders, mintDemoFloristLink } from "@/lib/testing/demoSandbox";
import { isOrderScenarioId, ORDER_SCENARIOS } from "@/lib/testing/orderScenarios";
import { toScenarioRunResult, summarizeScenarioRuns } from "@/lib/testing/demoSummary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Production/order-loop demo sandbox — admin-only, same gate as
// /api/testing (the Recruiting-side harness): this creates florists and orders
// and fires real sends, just scoped to shops it creates and owns. See
// dashboard/lib/testing/demoSandbox.ts for the full safety writeup.

export async function GET(): Promise<Response> {
  const gate = await requireRole("admin");
  if (!gate.ok) return gate.res;
  const admin = createServiceClient();
  const result = await listDemoOrders(admin);
  if (!result.ok) return jsonError(result.error, 500);
  return Response.json({ orders: result.orders });
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("admin");
  if (!gate.ok) return gate.res;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const action = String(body.action ?? "");
  const admin = createServiceClient();

  if (action === "setup") {
    const scenarioId = body.scenarioId;
    if (!isOrderScenarioId(scenarioId)) return jsonError("Unknown scenario.", 400);
    const cityId = typeof body.cityId === "string" && body.cityId ? body.cityId : null;
    const sourceOrderId = typeof body.sourceOrderId === "string" && body.sourceOrderId ? body.sourceOrderId : null;
    const result = await setupOrderScenario(admin, { scenarioId, cityId, sourceOrderId });
    if (!result.ok) return jsonError(result.error ?? "Setup failed.", 422);
    return Response.json(result);
  }

  if (action === "setup_all") {
    const cityId = typeof body.cityId === "string" && body.cityId ? body.cityId : null;
    const sourceOrderId = typeof body.sourceOrderId === "string" && body.sourceOrderId ? body.sourceOrderId : null;

    // Sequential ON PURPOSE — not Promise.all. These scenarios write shared
    // rows (ensureDemoShop in demoSandbox.ts is a find-or-create keyed on the
    // same place_id per city), so running them concurrently would race two
    // scenarios over the same demo shop row. One request setting up all six
    // presets in a batch is a "click one button before a demo" convenience,
    // not a throughput path, so sequential is the right (and only safe) call.
    const results: ReturnType<typeof toScenarioRunResult>[] = [];
    for (const scenario of ORDER_SCENARIOS) {
      try {
        const outcome = await setupOrderScenario(admin, { scenarioId: scenario.id, cityId, sourceOrderId });
        results.push(toScenarioRunResult(scenario.id, scenario.label, outcome));
      } catch (e) {
        // One scenario throwing (a DB hiccup, an unexpected exception inside
        // setupOrderScenario) must never fail the whole batch — record it and
        // move on to the next preset.
        results.push(toScenarioRunResult(scenario.id, scenario.label, null, e));
      }
    }

    const summary = summarizeScenarioRuns(results);
    // `ok: true` here means "the batch ran to completion", NOT "every
    // scenario succeeded" — per-scenario success is in `results[i].ok` and
    // rolled up in `succeeded`/`failed`. Only auth failure, bad JSON, or an
    // unknown action get a non-200 from this route.
    return Response.json({ ok: true, ...summary });
  }

  if (action === "florist_link") {
    const assignmentId = body.assignmentId;
    if (typeof assignmentId !== "string" || !assignmentId) return jsonError("assignmentId is required.", 400);
    const result = await mintDemoFloristLink(admin, assignmentId);
    if (!result.ok) return jsonError(result.error, result.reason === "not-found" ? 404 : 422);
    return Response.json({ ok: true, url: result.url });
  }

  if (action === "cleanup") {
    const result = await cleanupDemoSandbox(admin);
    return Response.json({ ok: true, ...result });
  }

  return jsonError("Unknown action.", 400);
}
