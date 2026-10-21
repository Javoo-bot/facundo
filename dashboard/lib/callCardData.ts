// The one read behind both operator screens: `/orders/[id]` (what does this
// order need?) and `/orders/[id]/call` (who am I calling?).
//
// They share a loader so they can never disagree about how many shops were
// asked, which of them engaged, or who is reachable — the same class of bug
// the CX desk avoids by routing everything through lib/cxAttention.ts.

import { createServerClient } from "@/lib/supabase";
import { resolveCandidateEngagement } from "@/lib/candidateEngagement";
import { haversineKm } from "@/lib/geo";
import { rankCallTargets, type CallCandidate } from "@/lib/callCard";
import type { Order, OrderLineItem, OrderAssignment, Florist } from "@/lib/types";
import type { AssignmentStatus } from "@/lib/orderStatus";

export interface OrderCallData {
  order: Order;
  items: OrderLineItem[];
  /** Every candidate, warmest first, withdrawn ones already removed. */
  ranked: CallCandidate[];
  /** Raw assignment statuses, including withdrawn — orderNeed() counts asked shops. */
  assignmentStatuses: string[];
  cityLabel: string | null;
}

/** A shop's number, normalised. Empty strings live in `phone_maps` for shops
 *  scraped without one, and an empty string is not a phone number. */
export function normalisePhone(...values: (string | null | undefined)[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export async function loadOrderCallData(orderId: string): Promise<OrderCallData | null> {
  const supabase = await createServerClient();

  const [{ data: order }, { data: items }, { data: assignments }] = await Promise.all([
    supabase.from("orders").select("*").eq("id", orderId).maybeSingle(),
    supabase.from("order_line_items").select("*").eq("order_id", orderId),
    supabase.from("order_assignments").select("*").eq("order_id", orderId).order("rank", { nullsFirst: false }),
  ]);
  if (!order) return null;

  const asg = (assignments ?? []) as OrderAssignment[];
  const floristIds = asg.map((a) => a.florist_id);
  const assignmentIds = asg.map((a) => a.id);

  const [{ data: florists }, { data: city }] = await Promise.all([
    floristIds.length
      ? supabase.from("florists").select("*").in("id", floristIds)
      : Promise.resolve({ data: [] as Florist[] }),
    (order as Order).city_id
      ? supabase.from("cities").select("city, country").eq("id", (order as Order).city_id!).maybeSingle()
      : Promise.resolve({ data: null as { city: string; country: string } | null }),
  ]);

  // Non-fatal, exactly as on the full record: the card's primary job is naming
  // the shop and its number. Without engagement every candidate simply reads as
  // "no sign they have seen it", which is the honest default.
  const engagement = await resolveCandidateEngagement(
    asg.map((a) => ({ id: a.id, florist_id: a.florist_id, sent_at: a.sent_at ?? null })),
  ).catch((err: unknown) => {
    console.error("call card: engagement unavailable —", err instanceof Error ? err.message : err);
    return null;
  });

  // Every unanswered call on this order, newest first. Kept as events rather
  // than a column on the assignment because a call is a thing that HAPPENED,
  // not a state the shop is in — and the count matters as much as the last one.
  const { data: noAnswerEvents } = await supabase
    .from("order_events")
    .select("payload, created_at")
    .eq("order_id", orderId)
    .eq("type", "call_no_answer")
    .order("created_at", { ascending: false });
  const noAnswerByAssignment = new Map<string, { last: string; count: number }>();
  for (const e of noAnswerEvents ?? []) {
    const id = (e.payload as { assignmentId?: string } | null)?.assignmentId;
    if (!id) continue;
    const prev = noAnswerByAssignment.get(id);
    // Rows arrive newest-first, so the first one seen is the most recent.
    if (prev) prev.count += 1;
    else noAnswerByAssignment.set(id, { last: e.created_at as string, count: 1 });
  }

  // The desk's own call-back ladder. Per-field fallback (in callBackGapMinutes)
  // so a missing settings row or a single null column degrades to the shipped
  // defaults rather than collapsing a gap to zero and turning the cooldown off.
  const { data: gapCfg } = await supabase
    .from("app_settings")
    .select("call_back_gap_rush_min, call_back_gap_sameday_min, call_back_gap_standard_min, call_back_gap_far_min, call_back_gap_nodate_min")
    .eq("id", 1)
    .maybeSingle();
  const gaps = gapCfg
    ? {
        rush: gapCfg.call_back_gap_rush_min,
        sameday: gapCfg.call_back_gap_sameday_min,
        standard: gapCfg.call_back_gap_standard_min,
        far: gapCfg.call_back_gap_far_min,
        noDate: gapCfg.call_back_gap_nodate_min,
      }
    : null;

  const byFlorist = new Map((florists ?? []).map((f) => [f.id, f as Florist]));
  const o = order as Order;

  const candidates: CallCandidate[] = asg.flatMap((a) => {
    const f = byFlorist.get(a.florist_id);
    if (!f) return [];
    const e = engagement?.get(a.id) ?? null;
    return [{
      assignmentId: a.id,
      floristId: a.florist_id,
      rank: a.rank,
      status: a.status as AssignmentStatus,
      withdrawnAt: a.withdrawn_at ?? null,
      payoutPrice: a.payout_price,
      declineReason: a.decline_reason,
      declineDetail: a.decline_detail,
      declinedAt: a.declined_at ?? null,
      name: f.name,
      phone: normalisePhone(f.phone_maps, f.phone_web),
      ownerName: normalisePhone(f.owner_name),
      lifecycleStage: f.lifecycle_stage,
      rating: f.rating,
      reviewCount: f.review_count,
      address: f.address,
      distanceKm: haversineKm(f.lat, f.lng, o.delivery_lat, o.delivery_lng),
      lastNoAnswerAt: noAnswerByAssignment.get(a.id)?.last ?? null,
      noAnswerCount: noAnswerByAssignment.get(a.id)?.count ?? 0,
      sentAt: a.sent_at ?? null,
      deliveredAt: e?.at.delivered ?? null,
      openedAt: e?.at.opened ?? null,
      clickedAt: e?.at.clicked ?? null,
      signedInAt: e?.at.signed_in ?? null,
    }];
  });

  return {
    order: o,
    items: (items ?? []) as OrderLineItem[],
    // Cooldown is relative to THIS order's delivery time — a rush order gets
    // rung back in ten minutes, one four days out is left alone for two hours.
    ranked: rankCallTargets(candidates, { deliveryAt: (order as Order).delivery_at ?? null, gaps }),
    assignmentStatuses: asg.map((a) => a.status),
    cityLabel: city ? `${city.city}, ${city.country}` : null,
  };
}
