import { requireAllowedUser, jsonError } from "@/lib/apiAuth";
import { reconcileOrders } from "@/lib/ingestWorker";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { parseOrderNames } from "@/lib/workingSet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Add orders to, or remove them from, the WORKING SET — the set of orders staff
// have said the system should actually operate on (see
// docs/superpowers/specs/2026-08-11-order-working-set-and-perf-design.md).
//
// Two ways in, both landing here:
//   1. The orders list, "Add orders by number": a pasted list of order numbers
//      ("#2000018, …"), sent as `orderNames`.
//   2. The orders list: tick rows → "Add to working set", sent as `orderIds`.
//
// Any allowed staff member can drive this — it selects what gets worked, it does
// not destroy anything, and removing an order NEVER rewinds work already in
// flight (matching only ever fires on an order still at "received"). Bulk delete
// on the same rows stays admin-only; this is deliberately a lower bar.
//
// Names are resolved, never fabricated: an order number we haven't pulled from
// Shopify yet is reported back in `notFound` rather than silently dropped.

// Upper bound on one call. Both shapes end up in a PostgREST `.in(...)`, which
// becomes a query-string filter — an unbounded list would build a URL long
// enough to be rejected by the gateway (or to lock the table for an
// unreasonable UPDATE). 500 is far above any real paste: a working set is a
// handful of orders, and the whole open-order backlog is ~400.
const MAX_PER_CALL = 500;

interface Body {
  /** Order ids (from the list's row selection). */
  orderIds?: string[];
  /** Raw pasted text, or an array of order names (from "Add orders by number"). */
  orderNames?: string | string[];
  /** true = remove from the working set. Default false = add. */
  remove?: boolean;
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requireAllowedUser();
  if (!gate.ok) return gate.res;

  let body: Body;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const ids = Array.isArray(body.orderIds) ? body.orderIds.filter((v) => typeof v === "string" && v) : [];
  const rawNames = body.orderNames;
  const names = parseOrderNames(
    typeof rawNames === "string" ? rawNames : Array.isArray(rawNames) ? rawNames.join(",") : ""
  );

  if (!ids.length && !names.length) {
    return jsonError("Provide orderIds, or orderNames like “#2000018, #2000026”.", 400);
  }
  // Reject rather than silently truncate — a caller that sent 600 orders and
  // got "ok, 500 done" would have no way to know the other 100 were dropped.
  if (ids.length + names.length > MAX_PER_CALL) {
    return jsonError(
      `Too many orders in one request (${ids.length + names.length}); the limit is ${MAX_PER_CALL}. Split it into smaller batches.`,
      400
    );
  }

  const admin = createServiceClient();

  // Resolve both shapes to real rows. `order_name` is what staff read off
  // Shopify; it's stored with the leading "#", which parseOrderNames normalises.
  // Soft-deleted orders are not resolvable — putting one in the working set
  // would select an order the list refuses to show.
  const [byId, byName] = await Promise.all([
    ids.length
      ? admin.from("orders").select("id, order_name").in("id", ids).is("deleted_at", null)
      : Promise.resolve({ data: [] as { id: string; order_name: string | null }[] }),
    names.length
      ? admin.from("orders").select("id, order_name").in("order_name", names).is("deleted_at", null)
      : Promise.resolve({ data: [] as { id: string; order_name: string | null }[] }),
  ]);

  const resolved = new Map<string, string | null>();
  for (const o of [...(byId.data ?? []), ...(byName.data ?? [])]) resolved.set(o.id, o.order_name);

  // Honest about what we couldn't find, rather than reporting a clean success
  // for a paste where half the numbers don't exist here yet.
  const foundNames = new Set((byName.data ?? []).map((o) => o.order_name));
  const notFound = names.filter((n) => !foundNames.has(n));

  if (!resolved.size) {
    return Response.json(
      { ok: true, count: 0, notFound, message: notFound.length ? "None of those order numbers are in the database yet." : "No matching orders." },
      { status: 200 }
    );
  }

  const removing = body.remove === true;
  const targetIds = [...resolved.keys()];
  const { error } = await admin
    .from("orders")
    .update(
      removing
        ? { worklist_at: null, worklist_by: null }
        : { worklist_at: new Date().toISOString(), worklist_by: gate.email }
    )
    .in("id", targetIds);
  if (error) {
    return jsonError(
      `Failed to ${removing ? "remove orders from" : "add orders to"} the working set: ${error.message}`,
      500
    );
  }

  // Same audit convention as every other staff action here (see
  // app/api/orders/delete/route.ts).
  await admin.from("order_events").insert(
    targetIds.map((id) => ({
      order_id: id,
      type: removing ? "worklist_removed" : "worklist_added",
      actor: gate.email,
      payload: { order_name: resolved.get(id) ?? null, bulk: targetIds.length > 1 },
    }))
  );

  const reconcile = !removing ? await reconcileOrders(targetIds).catch((e) => ({
    ok: false as const,
    status: 502,
    error: e instanceof Error ? e.message : "Could not trigger reconcile for newly added working-set orders.",
  })) : null;

  return Response.json({
    ok: true,
    count: targetIds.length,
    notFound,
    reconcile: reconcile?.ok ? reconcile.data : reconcile ? { ok: false, error: reconcile.error } : null,
  });
}
