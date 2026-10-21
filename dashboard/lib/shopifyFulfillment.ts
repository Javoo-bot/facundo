// CUSTOMER-VISIBLE Shopify fulfilment writes for the florist order loop.
//
// Deliberately a separate module from lib/shopifyWriteback.ts. That file's
// contract is, in its own words, "Staff-facing only: metafields + order note +
// tag. Never touches customer-visible fulfilment status." This one does exactly
// the opposite, and keeping them apart means that guarantee stays readable
// instead of becoming "…except sometimes".
//
// Two write points in the florist workflow:
//
//   florist (or CX) accepts  ->  fulfillmentCreateV2   -> order becomes `fulfilled`
//   florist uploads a photo  ->  fulfillmentEventCreate -> shipment `OUT_FOR_DELIVERY`
//
// NOTIFY_CUSTOMER IS ALWAYS FALSE. Shopify sends its own shipping-confirmation
// email on a fulfilment unless told not to, and customer email for this rail is
// owned elsewhere. A `true` here would mail every buyer from a second system.
//
// NO TRACKING INFO IS EVER SENT. A florist hand-delivers; there is no carrier
// and no tracking number. This also matters upstream: the Mechanic task
// `docs/flow-shopify/order_on_their_way.liquid` PUTs to Ongage the moment any fulfilment on an
// order carries a tracking number, which would send an "on the way" email at
// ACCEPT time — days before the bouquet exists. That task also has an explicit
// `local-florist` guard, so this is belt and braces, but do not "helpfully" add
// a tracking number here.
//
// SCOPES: write_fulfillments AND write_merchant_managed_fulfillment_orders.
// The second is the one that is easy to miss. write_fulfillments lets you CALL
// the mutations; it does not grant access to the fulfillment orders, which is
// decided by the location they are assigned to. Both of this store's locations
// are merchant-managed. With only the first scope, the fulfillment order is
// still readable and its supportedActions come back HOLD/SPLIT with no
// CREATE_FULFILLMENT, and the mutation fails 'The api_client does not have
// access to the fulfillment order' — which reads like a bad token rather than a
// missing scope. Verified live 2026-09-15 against the production store.
//
// API VERSION: 2024-07, in step with shopifyParse.ts / shopifyWriteback.ts /
// shopifyImages.ts. `fulfillmentCreateV2` is the mutation name on 2024-07; it
// was renamed `fulfillmentCreate` on later versions, so bumping API above needs
// this renamed too.

import { captureError } from "./monitor";
import { createServiceClient } from "./supabaseAdmin";
import { logExternalOp } from "./externalOps";
import { writebackEnabled } from "./shopifyWriteback";
// Pure decision helpers live next door so they unit-test under plain
// `node --test` — see lib/fulfilmentRules.ts's header.
import { fulfillableOrders, userErrorMessage, toGid, readDryRunSignal, type RawFulfillmentOrder } from "./fulfilmentRules";

export { fulfillableOrders, userErrorMessage, toGid, readDryRunSignal };
export type { RawFulfillmentOrder };

const API = "2024-07";

function base() { return `https://${process.env.SHOPIFY_SHOP}/admin/api/${API}`; }
function headers() {
  return {
    "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN!,
    "Content-Type": "application/json",
  };
}

export interface FulfilResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  fulfillmentId?: string | null;
}

// ---------------------------------------------------------------------------
// Safeguard: ONE switch, the existing `app_settings.shopify_writeback_enabled`
// ("Write status back to Shopify orders", Settings -> External services).
//
// Deliberately NOT a second toggle of its own. That was built and backed out on
// 2026-09-16: one switch for "touch Shopify or don't" is what ops actually
// reason about, and a second one is a thing to forget.
//
// The consequence is worth stating plainly, because it is not obvious: that
// switch is ON in production today, and it used to mean "write notes, tags and
// metafields" — things a buyer never sees. It now ALSO means "change the order's
// customer-visible fulfilment status". Shipping this code is therefore the
// activation; there is no dormant period. Turning it off to stop fulfilment also
// stops the staff-facing writeback, since they are the same switch.
//
// Fails CLOSED: writebackEnabled() returns false on any read error, so a
// settings hiccup can never mutate a customer's order.
// ---------------------------------------------------------------------------
export async function fulfilmentEnabled(): Promise<boolean> {
  return writebackEnabled();
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface GraphqlOutcome<T> { ok: boolean; status: number; data?: T; error?: string }

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<GraphqlOutcome<T>> {
  const res = await fetch(`${base()}/graphql.json`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ query, variables }),
  });
  type Body = { data?: T; errors?: Array<{ message?: string }> };
  let body: Body | null = null;
  try {
    body = (await res.json()) as Body;
  } catch {
    return { ok: false, status: res.status, error: `Shopify ${res.status}: unparseable body` };
  }
  // Top-level `errors` covers auth/scope/syntax failures. A missing
  // write_fulfillments scope lands here, NOT in userErrors — and it is the
  // single most likely failure when this ships, so surface it verbatim.
  if (body?.errors?.length) {
    return { ok: false, status: res.status, error: body.errors.map((e) => e?.message ?? "?").join("; ") };
  }
  if (!res.ok) return { ok: false, status: res.status, error: `Shopify ${res.status}` };
  return { ok: true, status: res.status, data: body?.data };
}

const FULFILLMENT_ORDERS_QUERY = `
  query FulfillmentOrders($id: ID!) {
    order(id: $id) {
      id
      fulfillmentOrders(first: 20) {
        nodes { id status requestStatus supportedActions { action } }
      }
      fulfillments(first: 10) { id status createdAt }
    }
  }`;

const FULFILLMENT_CREATE = `
  mutation FulfilLocalFlorist($fulfillment: FulfillmentV2Input!) {
    fulfillmentCreateV2(fulfillment: $fulfillment) {
      fulfillment { id status createdAt }
      userErrors { field message }
    }
  }`;

const FULFILLMENT_EVENT_CREATE = `
  mutation FulfilEvent($fulfillmentEvent: FulfillmentEventInput!) {
    fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
      fulfillmentEvent { id status happenedAt }
      userErrors { field message }
    }
  }`;

interface OrderProbe {
  order?: {
    id: string;
    fulfillmentOrders?: { nodes?: RawFulfillmentOrder[] };
    fulfillments?: Array<{ id: string; status?: string; createdAt?: string }>;
  } | null;
}

/** Read an order's fulfillment orders + existing fulfillments. Also the probe a
 *  dry run uses to prove the token, the scopes and the order id are all good
 *  WITHOUT writing anything. */
export async function inspectOrder(shopifyOrderId: string): Promise<{
  ok: boolean;
  error?: string;
  fulfillable: string[];
  existingFulfillmentIds: string[];
  /** Fulfillment orders Shopify says we may CREATE_FULFILLMENT on. Distinct from
   *  `fulfillable`, which is our own OPEN/IN_PROGRESS filter: a fulfillment order
   *  can be OPEN and still refuse the action when the app lacks
   *  write_merchant_managed_fulfillment_orders. Comparing the two separates
   *  "wrong state" from "no access" — see this file's SCOPES header. */
  createAllowed: string[];
}> {
  const out = await graphql<OrderProbe>(FULFILLMENT_ORDERS_QUERY, { id: toGid("Order", shopifyOrderId) });
  if (!out.ok) return { ok: false, error: out.error, fulfillable: [], existingFulfillmentIds: [], createAllowed: [] };
  const order = out.data?.order;
  if (!order) return { ok: false, error: "order not found", fulfillable: [], existingFulfillmentIds: [], createAllowed: [] };
  const nodes = order.fulfillmentOrders?.nodes ?? [];
  return {
    ok: true,
    fulfillable: fulfillableOrders(nodes),
    createAllowed: nodes
      .filter((n) => (n.supportedActions ?? []).some((a) => a?.action === "CREATE_FULFILLMENT"))
      .map((n) => n.id),
    existingFulfillmentIds: (order.fulfillments ?? []).map((f) => f.id),
  };
}

// ---------------------------------------------------------------------------
// Write 1 — the florist (or CX) accepted: mark the order fulfilled.
// ---------------------------------------------------------------------------

export async function fulfilOnAccept(
  shopifyOrderId: string,
  extra: {
    orderId: string;
    actor?: string;
    /** Walk the whole path but COMMIT NOTHING.
     *
     * Resolves the order's fulfillment orders exactly as a real run does, then
     * sends fulfillmentCreateV2 with an EMPTY line-item list. Shopify has
     * nothing to fulfil so no state changes, but the request still passes
     * through auth, scopes and fulfillment-order access — so its rejection
     * proves whether a real write would land. See readDryRunSignal.
     *
     * Deliberately BYPASSES the Settings gate (fulfilmentEnabled): the point is
     * to prove the path without depending on that switch at all. Safe to do because
     * this branch cannot reach a committing mutation — and because it never
     * stamps the `shopify_fulfilled` order event, so orderClosure is untouched.
     */
    dryRun?: boolean;
  },
): Promise<FulfilResult & { wouldSucceed?: boolean; diagnosis?: string }> {
  const logBase = {
    provider: "shopify",
    operation: extra.dryRun ? "fulfilment_create_dryrun" : "fulfilment_create",
    direction: "out" as const,
    orderId: extra.orderId,
    ref: shopifyOrderId,
  };

  // The enable gate does not apply to a dry run — see the dryRun docs above.
  if (!extra.dryRun && !(await fulfilmentEnabled())) {
    await logExternalOp({ ...logBase, ok: null, skipped: true, meta: { reason: "fulfilment_disabled" } });
    return { ok: false, skipped: true };
  }

  const start = Date.now();
  try {
    const probe = await inspectOrder(shopifyOrderId);

    if (extra.dryRun) {
      if (!probe.ok) {
        await logExternalOp({ ...logBase, ok: false, skipped: true, error: probe.error, durationMs: Date.now() - start });
        return { ok: false, skipped: true, error: probe.error, wouldSucceed: false, diagnosis: `could not read the order: ${probe.error}` };
      }
      // Send the deliberately-empty mutation. This is the whole point: it
      // exercises auth + scope + fulfillment-order access and changes nothing.
      const probeOut = await graphql<{
        fulfillmentCreateV2?: { fulfillment?: { id: string } | null; userErrors?: unknown };
      }>(FULFILLMENT_CREATE, {
        fulfillment: { lineItemsByFulfillmentOrder: [], notifyCustomer: false },
      });
      const raw = probeOut.ok ? userErrorMessage(probeOut.data?.fulfillmentCreateV2?.userErrors) : (probeOut.error ?? null);
      const signal = readDryRunSignal(raw);
      const meta = {
        dryRun: true,
        fulfillableCount: probe.fulfillable.length,
        createAllowedCount: probe.createAllowed.length,
        fulfillmentOrderIds: probe.fulfillable,
        shopifySaid: raw,
        wouldSucceed: signal.wouldSucceed,
      };
      await logExternalOp({ ...logBase, ok: signal.wouldSucceed, skipped: true, durationMs: Date.now() - start, meta });
      // No order event is stamped: a dry run must leave orderClosure's
      // weFulfilled signal exactly as it found it.
      return {
        ok: signal.wouldSucceed,
        skipped: true,
        wouldSucceed: signal.wouldSucceed,
        diagnosis: signal.reason,
      };
    }

    if (!probe.ok) {
      await logExternalOp({ ...logBase, ok: false, error: probe.error, durationMs: Date.now() - start });
      return { ok: false, error: probe.error };
    }
    // Idempotent: a fulfilment already exists (a retry, a re-accept, or someone
    // fulfilled by hand in the admin). Do not create a second one — return the
    // existing id so the delivery leg still has something to attach its event to.
    if (probe.fulfillable.length === 0) {
      const existing = probe.existingFulfillmentIds[0] ?? null;
      await logExternalOp({
        ...logBase, ok: true, durationMs: Date.now() - start,
        meta: { reason: "nothing_fulfillable", alreadyFulfilled: !!existing, fulfillmentId: existing },
      });
      return { ok: true, skipped: true, fulfillmentId: existing };
    }

    const out = await graphql<{
      fulfillmentCreateV2?: { fulfillment?: { id: string } | null; userErrors?: unknown };
    }>(FULFILLMENT_CREATE, {
      fulfillment: {
        lineItemsByFulfillmentOrder: probe.fulfillable.map((id) => ({ fulfillmentOrderId: id })),
        notifyCustomer: false, // see the module header — never true
        // trackingInfo deliberately omitted — see the module header
      },
    });

    if (!out.ok) {
      await logExternalOp({ ...logBase, ok: false, error: out.error, statusCode: out.status, durationMs: Date.now() - start });
      return { ok: false, error: out.error };
    }
    const userErr = userErrorMessage(out.data?.fulfillmentCreateV2?.userErrors);
    if (userErr) {
      await logExternalOp({ ...logBase, ok: false, error: userErr, statusCode: out.status, durationMs: Date.now() - start });
      return { ok: false, error: userErr };
    }

    const fulfillmentId = out.data?.fulfillmentCreateV2?.fulfillment?.id ?? null;
    await logExternalOp({
      ...logBase, ok: true, statusCode: out.status, durationMs: Date.now() - start,
      meta: { fulfillmentId, fulfillmentOrders: probe.fulfillable.length },
    });
    await stamp(extra.orderId, "shopify_fulfilled", { fulfillmentId }, extra.actor ?? "system");
    return { ok: true, fulfillmentId };
  } catch (e) {
    captureError("shopify.fulfilment.create", e);
    const error = e instanceof Error ? e.message : "shopify error";
    await logExternalOp({ ...logBase, ok: false, error, durationMs: Date.now() - start });
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// Write 2 — the florist uploaded the delivery photo: the bouquet is out.
//
// OUT_FOR_DELIVERY, not DELIVERED. The photo proves the bouquet was made and
// has left the shop; it does not prove it reached the recipient. Claiming
// DELIVERED here would assert something we cannot know.
// ---------------------------------------------------------------------------

export async function markOutForDelivery(
  shopifyOrderId: string,
  extra: { orderId: string; actor?: string; fulfillmentId?: string | null },
): Promise<FulfilResult> {
  const logBase = {
    provider: "shopify",
    operation: "fulfilment_event",
    direction: "out" as const,
    orderId: extra.orderId,
    ref: shopifyOrderId,
  };

  if (!(await fulfilmentEnabled())) {
    await logExternalOp({ ...logBase, ok: null, skipped: true, meta: { reason: "fulfilment_disabled" } });
    return { ok: false, skipped: true };
  }

  const start = Date.now();
  try {
    // Resolve the fulfilment from Shopify rather than from anything we stored at
    // accept time. Stateless on purpose: it self-heals when the accept-time
    // write was skipped, retried, or done by hand in the admin, and there is no
    // local id to go stale.
    let fulfillmentId = extra.fulfillmentId ?? null;
    if (!fulfillmentId) {
      const probe = await inspectOrder(shopifyOrderId);
      if (!probe.ok) {
        await logExternalOp({ ...logBase, ok: false, error: probe.error, durationMs: Date.now() - start });
        return { ok: false, error: probe.error };
      }
      fulfillmentId = probe.existingFulfillmentIds[0] ?? null;
    }
    if (!fulfillmentId) {
      // No fulfilment to hang the event on. Real case: the accept-time write was
      // skipped (flag off, or it failed). Not an error worth failing the upload
      // over — recorded so it is visible, and the next accept-side fix repairs it.
      await logExternalOp({ ...logBase, ok: false, error: "no fulfilment on the order", durationMs: Date.now() - start });
      return { ok: false, error: "no fulfilment on the order" };
    }

    const out = await graphql<{
      fulfillmentEventCreate?: { fulfillmentEvent?: { id: string; status: string } | null; userErrors?: unknown };
    }>(FULFILLMENT_EVENT_CREATE, {
      fulfillmentEvent: {
        fulfillmentId,
        status: "OUT_FOR_DELIVERY",
        happenedAt: new Date().toISOString(),
      },
    });

    if (!out.ok) {
      await logExternalOp({ ...logBase, ok: false, error: out.error, statusCode: out.status, durationMs: Date.now() - start });
      return { ok: false, error: out.error };
    }
    const userErr = userErrorMessage(out.data?.fulfillmentEventCreate?.userErrors);
    if (userErr) {
      await logExternalOp({ ...logBase, ok: false, error: userErr, statusCode: out.status, durationMs: Date.now() - start });
      return { ok: false, error: userErr };
    }

    await logExternalOp({
      ...logBase, ok: true, statusCode: out.status, durationMs: Date.now() - start,
      meta: { fulfillmentId, status: "OUT_FOR_DELIVERY" },
    });
    await stamp(extra.orderId, "shopify_out_for_delivery", { fulfillmentId }, extra.actor ?? "system");
    return { ok: true, fulfillmentId };
  } catch (e) {
    captureError("shopify.fulfilment.event", e);
    const error = e instanceof Error ? e.message : "shopify error";
    await logExternalOp({ ...logBase, ok: false, error, durationMs: Date.now() - start });
    return { ok: false, error };
  }
}

// Order-timeline stamp. Also what tells the reconcile sweep that a `fulfilled`
// order was fulfilled BY US and is therefore not a Shopify conflict — see
// ingest-worker/src/shopifyLifecycle.ts::orderClosure.
async function stamp(orderId: string, type: string, payload: Record<string, unknown>, actor: string): Promise<void> {
  try {
    const admin = createServiceClient();
    await admin.from("order_events").insert({ order_id: orderId, type, payload, actor });
  } catch {
    /* best-effort — external_ops already recorded the call itself */
  }
}
