// Late-tag handling — the missing half of the working-set gate.
//
// A store app tags orders a few minutes AFTER checkout. The `orders/create`
// webhook fires immediately, so an order that will eventually carry a required
// "active" tag arrives here untagged: `isInWorkingSet` returns false, the order is
// parked at status "received" (never matched). When the tag lands later Shopify
// fires `orders/updated` — which the create/edited/cancelled handlers ignored,
// so the tag (and the match it should have triggered) were lost.
//
// This module closes that gap two ways, both converging on the same idempotent
// helper (`refreshTagsAndMaybeMatch`):
//   1. event-driven — `handleOrderUpdated` (wired to the orders/updated webhook);
//   2. safety net — the hourly reconcile sweep re-evaluates parked orders.
//
// Read-safety: an order that has already moved past "received" only ever gets
// its stored tags refreshed here — never re-matched — so a worked order can't be
// rewound. `insertCandidates` is itself idempotent (no-ops once candidates
// exist), so a racing update + sweep can't double-offer.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadMatchableFlorists,
  countAcceptedForDay,
  insertCandidates,
  appendOrderEvent,
  setOrderStatus,
  createServiceClient,
  replaceLineItems,
  loadTestShopMatching,
  loadMatchConfig,
} from "./db";
import { matchFlorists, capKm } from "./match";
import { deliveryArea, queueIngestForArea, type IngestRequest } from "./autoIngest";
import { isInWorkingSet, extractDeliveryCountry, type WorkingSetCriteria } from "./tags";
import { parseShopifyOrder } from "./shopify";
import { shopifyLifecycle, orderClosure } from "./shopifyLifecycle";
import { captureAutomationEvent, ORDER_MATCH_FAILED } from "./analytics";
import type { Env } from "./types";

/** Does a florist hold this order right now? Assignment-based, not status-based:
 *  in semi mode a matched order still rests at "received", so status alone can't
 *  tell us whether someone is out delivering with an accept-leg payout issued. */
async function hasFloristInFlight(sb: SupabaseClient, orderId: string): Promise<boolean> {
  const { count } = await sb
    .from("order_assignments")
    .select("id", { count: "exact", head: true })
    .eq("order_id", orderId)
    .in("status", ["accepted", "delivered"]);
  return (count ?? 0) > 0;
}

/** Did WE mark this order fulfilled in Shopify, at florist-accept time?
 *
 * dashboard/lib/shopifyFulfillment.ts stamps a `shopify_fulfilled` order event
 * when its fulfillmentCreate succeeds. That stamp is the only way the closure
 * rules can tell "Shopify says fulfilled because we said so" from "somebody
 * fulfilled this behind our back" — see orderClosure's weFulfilled branch.
 *
 * Fails CLOSED: any error reads as "we did not fulfil it", which yields the
 * pre-existing conflict behaviour. A missed conflict is worse than a spurious
 * one, so the safe default is the noisy one.
 */
export async function weFulfilledOrder(sb: SupabaseClient, orderId: string): Promise<boolean> {
  try {
    const { count } = await sb
      .from("order_events")
      .select("id", { count: "exact", head: true })
      .eq("order_id", orderId)
      .eq("type", "shopify_fulfilled");
    return (count ?? 0) > 0;
  } catch {
    return false;
  }
}

/** The columns a parked order needs for a late match. */
export interface ParkedOrderRow {
  id: string;
  status: string;
  tags: string | null;
  delivery_address: Record<string, unknown> | null;
  city_id: string | null;
  delivery_lat: number | null;
  delivery_lng: number | null;
  delivery_at: string | null;
  worklist_at?: string | null;
}

const PARKED_ORDER_COLUMNS =
  "id, status, tags, delivery_address, city_id, delivery_lat, delivery_lng, delivery_at, worklist_at";

/** Pure decision: should an order be (re-)matched now, given its current status
 * and the freshest tags against the working set (staff tags ∪ explicit picks)?
 * Only a parked ("received") order that now passes the gate qualifies —
 * anything already worked is left alone. Extracted so the branch is
 * unit-testable without a DB. */
export function shouldLateMatch(
  status: string,
  freshTags: string | null,
  deliveryCountry: string | null,
  criteria: WorkingSetCriteria,
  options: { hasExplicitPick?: boolean; deliveryAt?: string | null } = {},
): boolean {
  return status === "received" && isInWorkingSet({
    tags: freshTags, deliveryCountry,
    hasExplicitPick: options.hasExplicitPick,
    deliveryAt: options.deliveryAt,
  }, criteria);
}

export interface MatchParams {
  orderId: string;
  /** Reporting metadata only — candidates are loaded by geography now, not by
   *  city membership (see db.ts::loadMatchableFlorists). */
  cityId: string | null;
  deliveryLat: number | null;
  deliveryLng: number | null;
  deliveryAt: string | null;
  /** The order's actual (post-discount) total — the payout basis. See
   *  db.ts::insertCandidates::computePayoutPrice for why this must be the
   *  order's real total and not the pre-discount item price. */
  orderTotal: number;
  /** The raw delivery address, used only to name an area worth ingesting when
   *  nothing matched. Optional: a caller that omits it just gets no ingest. */
  deliveryAddress?: unknown;
}

/** Run matching for an order and write its candidate assignments — the exact
 * logic the OrderWorkflow's match + write-candidates steps run, factored out so
 * the late-tag path produces an identical result (candidates, "matched" event,
 * semi-mode approval row, and status transition). Idempotent via
 * `insertCandidates`. Returns the candidate count.
 *
 * `env` is optional and PostHog-only: every caller already has it in scope, but
 * passing it isn't required for correctness — it just enables the
 * `order_match_failed` event below (skipped, not thrown, when omitted). */
export async function matchAndWriteCandidates(sb: SupabaseClient, p: MatchParams, env?: Env): Promise<number> {
  // The staff-tuned knobs (Settings → Matching). Never throws — a failed read
  // yields the compiled defaults rather than stopping the match.
  const config = await loadMatchConfig(sb);
  const cap = capKm(config);
  // Candidates come from a bounding box around the DELIVERY POINT, not from the
  // order's city. An order in an uncovered suburb used to match nobody even with
  // florists 3km away; the cap is the boundary now, not the city name.
  const florists = await loadMatchableFlorists(sb, { lat: p.deliveryLat, lng: p.deliveryLng }, cap);
  // Same-day capacity: how many assignments each candidate already has
  // accepted/delivered for this order's delivery date (0 for everyone if
  // delivery_at is null).
  const counts = await countAcceptedForDay(sb, florists.map((f) => f.id), p.deliveryAt);
  const withCapacity = florists.map((f) => ({ ...f, accepted_count_for_day: counts.get(f.id) ?? 0 }));
  // Test shops (florists WE own) are excluded by default and can be made the
  // ONLY match target for end-to-end testing — see
  // supabase/migrations/2026-08-05-test-shops.sql. Fails safe to 'exclude'.
  const testShopMatching = await loadTestShopMatching(sb);
  const candidates = matchFlorists(
    { delivery_lat: p.deliveryLat, delivery_lng: p.deliveryLng, delivery_at: p.deliveryAt },
    withCapacity,
    config,
    testShopMatching,
  );

  await insertCandidates(sb, p.orderId, candidates, p.deliveryAt, p.orderTotal);
  await appendOrderEvent(sb, p.orderId, "matched", { candidates: candidates.length });

  const { data: mset } = await sb.from("app_settings").select("workflow_mode").eq("id", 1).maybeSingle();
  const mode = (mset?.workflow_mode as string | undefined) ?? "manual";

  // NOBODY IN RANGE. Two different situations wear the same zero: an area we've
  // never scraped, and an area we have scraped and that genuinely has no florist
  // we can use. `queueIngestForArea` tells them apart; either way the order
  // escalates now rather than waiting on a multi-minute job.
  let ingest: { area: IngestRequest | null; outcome: string } = { area: null, outcome: "not-needed" };
  if (candidates.length === 0) {
    const area = deliveryArea(p.deliveryAddress, cap);
    // Anchor the geocode to where this order actually goes, so a same-named
    // city in a different region (the San Carlos/Balears mismatch) doesn't
    // get cached as the answer for this area.
    if (area && p.deliveryLat != null && p.deliveryLng != null) {
      area.nearLat = p.deliveryLat;
      area.nearLng = p.deliveryLng;
    }
    if (!area) {
      ingest = { area: null, outcome: "no-area" };
    } else if (mode === "auto") {
      ingest = { area, outcome: await queueIngestForArea(sb, area) };
    } else {
      // semi defers the spend to the escalate approval below; manual defers it
      // to a human opening /ingest. Both still record the gap.
      ingest = { area, outcome: mode === "semi" ? "pending-approval" : "manual-mode" };
    }
    // The signal rematchOrdersAwaitingArea looks for once an ingest succeeds.
    await appendOrderEvent(sb, p.orderId, "awaiting_ingest", {
      country: area?.country ?? null, city: area?.city ?? null,
      radius_km: cap, outcome: ingest.outcome, mode,
    });
    // Health signal, not just an order-scoped record: an order with nobody in
    // range is exactly the case fully-automatic working-set operation can't
    // resolve without a human, so it's worth its own PostHog event rather than
    // only living in order_events.
    if (env) {
      await captureAutomationEvent(env, ORDER_MATCH_FAILED, p.orderId, {
        order_id: p.orderId, city_id: p.cityId, mode,
        area: area ? { country: area.country, city: area.city } : null,
        ingest_outcome: ingest.outcome,
      });
    }
  }

  // Mode handling mirrors OrderWorkflow.write-candidates: semi proposes an
  // approval (a `match` when there are candidates, else an `escalate`) and rests
  // the order at "received"; manual/auto advance the status directly. A 23505 on
  // the per-effect dedupe_key (a racing update/sweep) is a benign no-op.
  if (mode === "semi") {
    const row = candidates.length
      ? {
          order_id: p.orderId, kind: "match", status: "pending", dedupe_key: `match:${p.orderId}`,
          preview: { type: "match", candidates: candidates.map((c) => ({ floristId: c.florist_id, floristName: null, rank: c.rank, distanceKm: c.distance_km })) },
          payload: {}, created_by: "system",
        }
      : {
          order_id: p.orderId, kind: "escalate", status: "pending", dedupe_key: `escalate:${p.orderId}`,
          preview: {
            type: "reason",
            reason: ingest.area
              ? `No florist within ${cap}km — hand to CX to place manually. Approving also queues an ingest of ${ingest.area.city}, ${ingest.area.country}.`
              : "No florist matched — hand to CX to place manually.",
          },
          // `queue_ingest` is what makes approving the escalation ALSO spend the
          // money on a scrape — order_approvals allows one pending row per
          // order, so this can't be a separate approval of its own.
          payload: { from: "received", reason: "no_candidates", queue_ingest: ingest.area },
          created_by: "system",
        };
    const { error: aerr } = await sb.from("order_approvals").insert(row as Record<string, unknown>);
    if (aerr && (aerr as { code?: string }).code !== "23505") throw aerr;
    return candidates.length;
  }
  await setOrderStatus(sb, p.orderId, candidates.length ? "matched" : "escalated");
  return candidates.length;
}

/** Refresh a stored order's tags to the freshest Shopify value and, if that
 * flips a parked order past the active-tag gate, run the match it missed at
 * create time. Safe to call repeatedly and concurrently. Returns what it did. */
export async function refreshFromShopify(
  sb: SupabaseClient,
  row: ParkedOrderRow,
  raw: unknown,
  criteria: WorkingSetCriteria,
  env?: Env,
): Promise<"matched" | "closed" | "conflict" | "updated" | "noop"> {
  const { order: parsed, items } = parseShopifyOrder(raw);
  const freshTags = parsed.tags;

  // 1. SHOPIFY-OWNED COLUMNS. An explicit allow-list rather than
  // `upsertOrder(parsed)`, because parseShopifyOrder hard-codes
  // `status: "received"` — a blind upsert would rewind every order it touched.
  // `status` and `city_id` are ours and are never written from here.
  const owned = {
    order_name: parsed.order_name, shopify_created_at: parsed.shopify_created_at,
    currency: parsed.currency, total: parsed.total, shipping_total: parsed.shipping_total,
    financial_status: parsed.financial_status, fulfillment_status: parsed.fulfillment_status,
    locale: parsed.locale, buyer_name: parsed.buyer_name, buyer_email: parsed.buyer_email,
    buyer_phone: parsed.buyer_phone, recipient_name: parsed.recipient_name,
    recipient_phone: parsed.recipient_phone, delivery_address: parsed.delivery_address,
    delivery_area: parsed.delivery_area, delivery_lat: parsed.delivery_lat,
    delivery_lng: parsed.delivery_lng, delivery_at: parsed.delivery_at,
    delivery_window: parsed.delivery_window, occasion: parsed.occasion,
    greeting: parsed.greeting, tags: parsed.tags, raw: parsed.raw,
  };
  await sb.from("orders").update(owned).eq("id", row.id);
  // Line items feed the payout basis, so an edited order has to bring them along.
  await replaceLineItems(sb, row.id, items);

  let changed = false;
  if (freshTags !== row.tags) {
    await appendOrderEvent(sb, row.id, "tags_updated", { tags: freshTags });
    changed = true;
  }

  // 2. CLOSURE. Shopify is the truth about whether this order is still live.
  const action = orderClosure(
    shopifyLifecycle(raw),
    row.status,
    await hasFloristInFlight(sb, row.id),
    await weFulfilledOrder(sb, row.id)
  );
  if (action.kind === "close") {
    await setOrderStatus(sb, row.id, action.to);
    // A pending step-mode approval on a finished order is stale work in the CX
    // queue — resolving it is what actually clears the order out of /cx.
    await sb.from("order_approvals").update({ status: "skipped" }).eq("order_id", row.id).eq("status", "pending");
    const life = shopifyLifecycle(raw);
    await appendOrderEvent(sb, row.id, "shopify_closed", {
      to: action.to, from: row.status, fulfilled: life.fulfilled, archived: life.archived, cancelled: life.cancelled,
    });
    return "closed";
  }
  if (action.kind === "conflict") {
    // Once only — orders/updated fires on ANY mutation, and the sweep re-reads
    // the same order every hour; without this every pass would re-append.
    const { count } = await sb
      .from("order_events")
      .select("id", { count: "exact", head: true })
      .eq("order_id", row.id)
      .eq("type", "shopify_conflict");
    if ((count ?? 0) === 0) {
      const life = shopifyLifecycle(raw);
      await appendOrderEvent(sb, row.id, "shopify_conflict", {
        our_status: row.status, fulfilled: life.fulfilled, archived: life.archived,
      });
    }
    return "conflict";
  }

  const deliveryCountry = extractDeliveryCountry(parsed.delivery_address);
  if (!shouldLateMatch(row.status, freshTags, deliveryCountry, criteria, {
    hasExplicitPick: row.worklist_at != null,
    deliveryAt: parsed.delivery_at,
  })) return changed ? "updated" : "noop";

  // Already-matched guard. In semi mode a matched order stays at "received" (with
  // a pending approval), so status alone can't tell us it's been worked — and
  // orders/updated fires on ANY mutation, not just the tag arriving. matchAndWrite
  // always stamps a "matched" event (even a zero-candidate match that carries no
  // assignment row), so its presence is the reliable "already processed" signal.
  // Without this, every later update (and every sweep) would re-run the match and
  // re-append events; it also narrows the check-then-insert window a concurrent
  // update + sweep would otherwise race through.
  const { count } = await sb
    .from("order_events")
    .select("id", { count: "exact", head: true })
    .eq("order_id", row.id)
    .eq("type", "matched");
  if ((count ?? 0) > 0) return changed ? "updated" : "noop";

  await appendOrderEvent(sb, row.id, "late_matched", { tags: freshTags });
  const addr = (row.delivery_address ?? {}) as Record<string, unknown>;
  await matchAndWriteCandidates(sb, {
    orderId: row.id,
    cityId: row.city_id,
    deliveryLat: row.delivery_lat,
    deliveryLng: row.delivery_lng,
    deliveryAt: row.delivery_at,
    // The fresh re-parsed total (just written to `owned` above), not the stale
    // `row.total` this function was called with — an edited order must lock in
    // its payout basis off the total Shopify has NOW, same as the line items
    // just replaced above.
    orderTotal: parsed.total ?? 0,
    deliveryAddress: parsed.delivery_address,
  }, env);
  return "matched";
}

/** Load the current working-set criteria from app_settings — shared by every
 * caller of refreshTagsAndMaybeMatch (the orders/updated webhook, the
 * per-order admin reconcile action, and the reconcile sweep's two passes) so
 * the settings shape lives in one place. */
export async function loadWorkingSetCriteria(sb: SupabaseClient): Promise<WorkingSetCriteria> {
  const { data } = await sb
    .from("app_settings")
    .select("active_order_tags, active_order_countries, run_all_orders")
    .eq("id", 1)
    .maybeSingle();
  return {
    activeOrderTags: (data?.active_order_tags as string[] | null) ?? [],
    activeOrderCountries: (data?.active_order_countries as string[] | null) ?? [],
    runAllOrders: (data?.run_all_orders as boolean | null) ?? false,
  };
}

/** orders/updated webhook → refresh tags and, for a still-parked order that now
 * qualifies, run its late match. If we've never seen the order (the update
 * raced ahead of create, or create was dropped) fall back to the normal intake
 * queue so it's ingested exactly like a fresh order. */
export async function handleOrderUpdated(env: Env, raw: unknown): Promise<void> {
  const sb = createServiceClient(env);
  const { order: parsed } = parseShopifyOrder(raw);
  const shopifyOrderId = parsed.shopify_order_id;

  const { data: existing } = await sb
    .from("orders")
    .select(PARKED_ORDER_COLUMNS)
    .eq("shopify_order_id", shopifyOrderId)
    .maybeSingle();

  if (!existing) {
    await env.ORDER_QUEUE.send({ shopifyOrderId, raw });
    return;
  }

  const criteria = await loadWorkingSetCriteria(sb);
  // The whole payload, not just the tags: orders/updated fires on fulfilment and
  // archive too, and we used to discard both.
  await refreshFromShopify(sb, existing as unknown as ParkedOrderRow, raw, criteria, env);
}
