import "server-only";

import { createServiceClient } from "@/lib/supabaseAdmin";
import {
  matchFlorists,
  boundingBox,
  capKm,
  emailIdentifies,
  MATCHABLE,
  type MatchConfig,
  type MatchFlorist,
  type Candidate,
  type TestShopMatching,
} from "@/lib/match";

// Shared ranking for the backoffice "Find florists" flow. Both the preview
// (rank and explain, write nothing) and the commit (rank and insert candidate
// rows) go through `rankForOrder`, so what an operator sees in the panel is
// exactly what gets written when they press the button.
//
// Candidates are loaded by GEOGRAPHY, matching ingest-worker/src/db.ts::
// loadMatchableFlorists — a bounding box around the delivery point sized to the
// config's cap, with no city_id filter. The worker's automatic match and this
// re-match must load the same population, or the panel would show florists the
// automatic path can't see (or hide ones it can).

export interface RankedCandidate extends Candidate {
  florist_name: string | null;
  place_id: string | null;
  /** Already spoken for on this order — the same florist row, the same physical
   *  shop under another row, or the same inbox we already wrote to on an
   *  earlier wave. Shown greyed in the panel, and never re-inserted. */
  already_assigned: boolean;
}

export interface RankForOrderResult {
  order: {
    id: string;
    status: string;
    delivery_lat: number | null;
    delivery_lng: number | null;
    delivery_at: string | null;
    total: number | null;
  };
  config: MatchConfig;
  /** Best-first, INCLUDING candidates already assigned (flagged), so the panel
   *  can explain why a shop isn't offered again. */
  ranked: RankedCandidate[];
  /** Fresh candidates only, already trimmed to config.topN — what a commit
   *  would insert. */
  fresh: RankedCandidate[];
  /** How many florist rows were in range before filtering. */
  consideredCount: number;
  maxRank: number;
}

/** Not found, or the order has no coordinates to measure from. */
export type RankForOrderError = { error: string; status: number };

export async function rankForOrder(
  admin: ReturnType<typeof createServiceClient>,
  orderId: string,
  config: MatchConfig
): Promise<RankForOrderResult | RankForOrderError> {
  const { data: order } = await admin
    .from("orders")
    .select("id, status, delivery_lat, delivery_lng, delivery_at, total")
    .eq("id", orderId)
    .single();
  if (!order) return { error: "Order not found.", status: 404 };

  // An order we couldn't locate can't be matched by distance, and distance is
  // now the primary key. Say so rather than ranking everyone at distance-zero.
  if (order.delivery_lat == null || order.delivery_lng == null) {
    return { error: "This order's delivery address has no coordinates, so nobody can be ranked by distance.", status: 422 };
  }

  // Existing assignments — dedupe florists we've already offered/considered, and
  // continue ranks after the current max so new rows never collide.
  const { data: existing } = await admin
    .from("order_assignments")
    .select("florist_id, rank")
    .eq("order_id", orderId);
  const already = new Set((existing ?? []).map((a) => a.florist_id as string));
  const maxRank = (existing ?? []).reduce((m, a) => Math.max(m, (a.rank as number) ?? 0), 0);

  // Also dedupe by physical shop, not just florist_id. The same storefront can
  // exist as more than one florist row (ingest upserts on (city_id, place_id)),
  // so this catches a shop already offered on a PRIOR match under a different
  // city's record — something matchFlorists' within-run collapse can't see.
  //
  // And by INBOX, for the same reason one wave collapses candidates sharing an
  // address (see match.ts: one Issy order sent four offers to one recipient).
  // That collapse is per-run, so without this a refill wave writes to an
  // address an earlier wave already used — the same person reading "can you
  // deliver in <city>?" twice under two shop names. Only addresses that
  // IDENTIFY their shop take part, mirroring the within-run rule exactly: a
  // shop on a network's shared address is still reachable by phone/push, and
  // suppressing it here would throw away a deliverable florist to protect an
  // inbox the offer path already declines to write to.
  const existingIds = [...already].filter(Boolean);
  const alreadyPlaces = new Set<string>();
  const alreadyEmails = new Set<string>();
  if (existingIds.length) {
    const { data: exFlorists } = await admin
      .from("florists")
      .select("id, place_id, email, network_id, email_shared_count, email_bounced_at")
      .in("id", existingIds);
    for (const f of exFlorists ?? []) {
      if (f.place_id) alreadyPlaces.add(f.place_id as string);
      if (emailIdentifies(f as unknown as MatchFlorist) && f.email) alreadyEmails.add(f.email as string);
    }
  }

  const cap = capKm(config);
  const box = boundingBox(order.delivery_lat, order.delivery_lng, cap);
  const { data: florists } = await admin
    .from("florists")
    .select("id, place_id, name, email, network_id, email_shared_count, email_bounced_at, lat, lng, rating, review_count, lifecycle_stage, excluded_at, source, trust_tier, delivery_radius_km, capacity_per_day, is_test_shop")
    .in("lifecycle_stage", MATCHABLE)
    .is("excluded_at", null)
    .is("deleted_at", null)
    .gte("lat", box.minLat).lte("lat", box.maxLat)
    .gte("lng", box.minLng).lte("lng", box.maxLng);

  const rows = (florists ?? []) as unknown as (MatchFlorist & { name: string | null })[];
  const byId = new Map(rows.map((f) => [f.id, f]));

  // How this re-match treats test shops (florists WE own). Defaults to
  // 'exclude' if the settings row is unreadable, so a failed read can never
  // route a paying customer's order to a test shop.
  const { data: shopMode } = await admin.from("app_settings").select("test_shop_matching").eq("id", 1).maybeSingle();
  const testShopMatching: TestShopMatching = shopMode?.test_shop_matching === "only" ? "only" : "exclude";

  // Rank the FULL population first (topN raised), so the panel can show what was
  // considered and why a shop was skipped. The trim to config.topN happens after
  // the already-assigned filter below, on the fresh list only.
  const ranked = matchFlorists(
    { delivery_lat: order.delivery_lat, delivery_lng: order.delivery_lng, delivery_at: order.delivery_at },
    rows,
    { ...config, topN: Number.MAX_SAFE_INTEGER },
    testShopMatching
  ).map((c): RankedCandidate => {
    const f = byId.get(c.florist_id);
    const place = f?.place_id ?? null;
    const inbox = f && emailIdentifies(f) ? f.email ?? null : null;
    return {
      ...c,
      florist_name: f?.name ?? null,
      place_id: place,
      already_assigned:
        already.has(c.florist_id) ||
        (!!place && alreadyPlaces.has(place)) ||
        (!!inbox && alreadyEmails.has(inbox)),
    };
  });

  const fresh = ranked.filter((c) => !c.already_assigned).slice(0, config.topN);

  return {
    order: order as RankForOrderResult["order"],
    config,
    ranked,
    fresh,
    consideredCount: rows.length,
    maxRank,
  };
}

export function isRankError(r: RankForOrderResult | RankForOrderError): r is RankForOrderError {
  return (r as RankForOrderError).error !== undefined;
}
