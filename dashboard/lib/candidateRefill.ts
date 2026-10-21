import "server-only";

import { createServiceClient } from "@/lib/supabaseAdmin";
import { computePayoutPrice } from "@/lib/payoutMath";
import { rankForOrder, isRankError, type RankForOrderResult } from "@/lib/rematch";
import { statusAfterRefill, type OrderStatus } from "@/lib/orderStatus";
import type { MatchConfig } from "@/lib/match";

// Append a wave of fresh candidates to an order that already has some.
//
// This is the write half of the "Find florists" flow, extracted so the wave
// engine can run it unattended (lib/waves.ts) with exactly the semantics an
// operator gets from the panel. The ranking half is lib/rematch.ts::rankForOrder,
// which already excludes florists / physical shops / inboxes this order has
// tried and continues rank numbering past the current max.
//
// Why this cannot just call the worker's insertCandidates
// (ingest-worker/src/db.ts): that one no-ops the moment an order has ANY
// assignment — the idempotency guard that stops a re-delivered webhook from
// double-offering. Correct there, fatal here, since a refill is BY DEFINITION a
// second write to an order that already has candidates. Appending is a
// different operation from first-match, so it gets its own function rather than
// a flag that weakens the guard for both.

export interface RefillResult {
  added: number;
  floristIds: string[];
  /** Ranked-but-not-added count, i.e. everyone in range already tried. Lets the
   *  caller tell "nobody left" (escalate as pool_exhausted) apart from "nobody
   *  in range at all". */
  consideredCount: number;
}

export type RefillError = { error: string; status: number };

export function isRefillError(r: RefillResult | RefillError): r is RefillError {
  return (r as RefillError).error !== undefined;
}

/**
 * The payout price this order's offers are locked to.
 *
 * An order gets ONE price, set by whichever match wrote its first candidate.
 * Later waves reuse it rather than recomputing from today's
 * `default_payout_percent`, because two shops asked to do identical work for
 * the same order must be offered identical money — otherwise a percent change
 * mid-wave means shop #10 sees a different number than shop #1, and the two can
 * compare. Recomputing only when there is nothing to inherit (a first match, or
 * an order whose existing rows predate the column) keeps
 * ingest-worker/src/db.ts::insertCandidates as the single origin of the number.
 */
async function lockedPayout(
  admin: ReturnType<typeof createServiceClient>,
  orderId: string,
  orderTotal: number | null
): Promise<{ price: number; percent: number; inherited: boolean }> {
  const { data: existing } = await admin
    .from("order_assignments")
    .select("payout_price, payout_percent")
    .eq("order_id", orderId)
    .not("payout_price", "is", null)
    .order("rank", { ascending: true, nullsFirst: false })
    .limit(1);
  const prior = existing?.[0];
  if (prior?.payout_price != null) {
    return {
      price: prior.payout_price as number,
      percent: (prior.payout_percent as number | null) ?? 55,
      inherited: true,
    };
  }

  const { data: settings } = await admin.from("app_settings").select("default_payout_percent").eq("id", 1).single();
  const percent = settings?.default_payout_percent ?? 55;
  return { price: computePayoutPrice(orderTotal ?? 0, percent), percent, inherited: false };
}

export interface RefillOptions {
  /** Written to the `rematched` order event. Staff email for a panel click,
   *  "system" for a wave. */
  actor: string;
  /** Recorded on the event so a surprising match can be explained later. */
  configOverridden?: boolean;
  /** Extra event payload — the wave engine records which wave this was. */
  eventExtra?: Record<string, unknown>;
  /** Pre-ranked result, when the caller already has one (the panel's commit
   *  path ranks first to show the operator). Skips a second ranking pass. */
  preRanked?: RankForOrderResult;
}

/**
 * Rank, then insert the next `config.topN` untried florists as candidates.
 *
 * Returns `added: 0` (not an error) when everyone in range is already on the
 * order — the caller decides what that means. Never moves the order backward:
 * a `received` or `escalated` order is nudged to `matched` so the wave engine
 * picks it up again, and any later status is left alone.
 */
export async function refillCandidates(
  admin: ReturnType<typeof createServiceClient>,
  orderId: string,
  config: MatchConfig,
  opts: RefillOptions
): Promise<RefillResult | RefillError> {
  const result = opts.preRanked ?? (await rankForOrder(admin, orderId, config));
  if (isRankError(result)) return result;

  const { order, fresh, maxRank, ranked } = result;
  if (fresh.length === 0) return { added: 0, floristIds: [], consideredCount: ranked.length };

  const payout = await lockedPayout(admin, orderId, order.total);

  // 2h before the delivery window, mirroring ingest-worker/src/db.ts::
  // insertCandidates. Recomputed rather than inherited: it is a property of the
  // ORDER's deadline, not of the offer, so it must not drift if delivery moved.
  const slaDeadline = order.delivery_at
    ? new Date(new Date(order.delivery_at).getTime() - 2 * 3600 * 1000).toISOString()
    : null;

  // Always `race`, never `exclusive`. Only the very first candidate of the
  // first match gets an exclusive offer; a refilled wave is by definition not
  // that, and index-0-is-exclusive would mint a fresh "exclusive" every wave.
  const rows = fresh.map((c, i) => ({
    order_id: orderId,
    florist_id: c.florist_id,
    rank: maxRank + i + 1,
    florist_source: c.source,
    status: "candidate" as const,
    offer_kind: "race" as const,
    sla_deadline_at: slaDeadline,
    payout_price: payout.price,
    payout_percent: payout.percent,
  }));

  const { error: insErr } = await admin.from("order_assignments").insert(rows);
  if (insErr) return { error: "Could not add candidates.", status: 500 };

  // Put the order back where the wave engine can see it.
  //
  // `received` is the plain first-match case. `escalated` is the one that
  // matters, and it was missing: that status means "we ran out of shops, a
  // human owns this now", and the refill above has just made it untrue. Left
  // escalated, the candidates we only now wrote are stranded — advanceWaves()
  // selects on ["matched", "reaching_out"] and never looks at an escalated
  // order again, so nothing would ever offer them. From /operator that is
  // invisible: the button runs, rows land in order_assignments, no offer is
  // sent, and the row re-renders identically. The one control that could
  // rescue it (a manual send, or Resolve escalation) lives on /orders/[id],
  // which the staging CX operator does not work in — so it was a dead end,
  // not just a confusing click. Found 2026-09-01 mapping the Operator flow.
  //
  // Only reached on a run that actually ADDED someone (we return early above
  // when `fresh` is empty), and CAS'd on the status we ranked against, so a
  // concurrent accept/decline wins and the order is never pulled backwards out
  // of reach-out, acceptance or fulfilment.
  //
  // `escalation_reason` is cleared with it: "the list ran out" is a false
  // claim about an order that now has fresh candidates, and
  // placementAttentionReason() reads that column to decide what the CX row
  // says if this order ever escalates again.
  const nextStatus = statusAfterRefill(order.status as OrderStatus);
  if (nextStatus) {
    await admin
      .from("orders")
      .update({ status: nextStatus, escalation_reason: null })
      .eq("id", orderId)
      .eq("status", order.status);
  }

  await admin.from("order_events").insert({
    order_id: orderId,
    type: "rematched",
    actor: opts.actor,
    payload: {
      added: rows.length,
      florist_ids: fresh.map((c) => c.florist_id),
      payout_inherited: payout.inherited,
      config: { ringEdgesKm: config.ringEdgesKm, topN: config.topN, requireTrustTier: config.requireTrustTier },
      overridden: opts.configOverridden === true,
      ...(opts.eventExtra ?? {}),
    },
  });

  return { added: rows.length, floristIds: fresh.map((c) => c.florist_id), consideredCount: ranked.length };
}
