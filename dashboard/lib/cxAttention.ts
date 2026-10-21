import type { SupabaseClient } from "@supabase/supabase-js";
import { isInWorkingSet, extractDeliveryCountry, type WorkingSetCriteria } from "@/lib/orderTags";
import { issueLabel } from "@/lib/i18n/issueLabels";
import { unresolvedConflictOrderIds, CONFLICT_EVENT, CONFLICT_RESOLVED_EVENT } from "@/lib/shopifyConflict";
import {
  placementAttentionReason,
  isHumanEngagement,
  ENGAGED_THEN_SILENT_REASON,
  photoVerdictAttentionReasons,
  LIVE_OFFER,
  IN_FULFILMENT,
  NEEDS_PLACING,
  type CxCategory,
  type CxReason,
  type OfferEngagementEvidence,
} from "./cxAttentionRules";

// The CX attention desk: gathers everything that needs a human across the loop —
// unplaceable orders, stalling offers, florist issues + unread messages, late
// deliveries, disputes, and money problems — into ONE prioritized, per-order
// list. Read via the staff session client (allow-list RLS covers every table).

// Re-exported for existing callers (components/orders/CxAttention.tsx,
// lib/authCache.ts, lib/cxAlertRules.ts) — the types themselves now live in
// cxAttentionRules.ts (see that file's header for why: it's the pure,
// import-free half of this module, importable outside a Next.js build).
export type { CxCategory, CxReason };

export interface CxAttentionRow {
  orderId: string;
  orderName: string | null;
  deliveryAt: string | null;
  status: string | null;
  primary: CxReason; // most urgent reason (drives the row)
  others: CxReason[];
  categories: CxCategory[];
  unread: boolean;
  urgency: number;
}

// Per-kind label + urgency for a pending step-mode approval (semi). Loop-advancing
// kinds block the order and rank high; notify/writeback kinds are lower.
export const APPROVAL_ATTENTION: Record<string, { label: string; urgency: number }> = {
  match: { label: "Approve match — make candidates live", urgency: 88 },
  offer: { label: "Approve offer to send", urgency: 95 },
  reassign: { label: "Approve reassign to next florist", urgency: 88 },
  escalate: { label: "Approve escalation to CX", urgency: 82 },
  writeback: { label: "Approve Shopify write-back", urgency: 68 },
  client_assigned: { label: "Approve customer ‘assigned’ email", urgency: 72 },
  client_on_the_way: { label: "Approve customer ‘on the way’ email", urgency: 72 },
  client_delivered: { label: "Approve customer ‘delivered’ email", urgency: 72 },
  // Ranked below a stuck match or offer: the order HAS a florist, and the risk
  // is that they are quiet rather than that nobody has it. Still above the
  // customer emails, because the delivery date is the thing at stake.
  chase_photo: { label: "Florist accepted but has not started", urgency: 84 },
};

// Held-payout reasons that are a substantive finding (see lib/payoutHold.ts) —
// used to tell staff WHY a held payout needs them, not just that it's held.
// `delivery-gate`-only holds are swept for auto-release on a cron tick
// (lib/payout.ts::sweepHeldPayouts) and should rarely reach this list; if the
// sweep hasn't run yet, "operator hold switch" is still an honest label.
//
// `photo-verdict` can no longer be newly parked — that hold is disabled as of
// 2026-08-20 (see lib/payoutHold.ts's header comment) — but the label stays
// so any pre-existing held row still carrying that stored reason renders
// correctly instead of falling back to the generic "review needed".
const HELD_REASON_LABEL: Record<string, string> = {
  "tier-hold": "untrusted tier",
  "provisional-shop": "unvetted cold-offer shop",
  "photo-verdict": "photo flagged by AI check (legacy — this hold is now disabled)",
  "delivery-gate": "operator hold switch",
};

// Small bonus so the more-overdue an SLA/delivery deadline is, the higher it rises.
function overdueBonus(deadlineIso: string | null): number {
  if (!deadlineIso) return 0;
  const mins = (Date.now() - new Date(deadlineIso).getTime()) / 60000;
  return mins <= 0 ? 0 : Math.min(30, mins / 6);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase rows are loosely typed
type Row = any;

export async function gatherAttention(sb: SupabaseClient): Promise<CxAttentionRow[]> {
  const nowIso = new Date().toISOString();
  const byOrder = new Map<string, CxReason[]>();
  const add = (orderId: string, r: CxReason) => {
    const arr = byOrder.get(orderId) ?? [];
    arr.push(r);
    byOrder.set(orderId, arr);
  };
  const info = new Map<string, { order_name: string | null; delivery_at: string | null; status: string | null; tags: string | null; delivery_address: Record<string, unknown> | null; worklist_at: string | null }>();
  const remember = (o: Row) => {
    if (o && !info.has(o.id)) info.set(o.id, {
      order_name: o.order_name ?? null,
      delivery_at: o.delivery_at ?? null,
      status: o.status ?? null,
      tags: o.tags ?? null,
      delivery_address: o.delivery_address ?? null,
      worklist_at: o.worklist_at ?? null,
    });
  };

  // Merge note: `escalatedThreads` (support conversations awaiting a human)
  // arrived on main while the working-set gate expanded from picked/tagged
  // orders to tag/country/run-all criteria. Both are kept.
  const [settings, statusOrders, liveOffers, reachingOrders, lateOrders, issues, moneyPayouts, deadEffects, offerApprovals, shopifyConflicts, escalatedThreads, badPhotoVerdicts] = await Promise.all([
    sb.from("app_settings").select("active_order_tags, active_order_countries, run_all_orders").eq("id", 1).maybeSingle(),
    sb.from("orders").select("id, order_name, status, delivery_at, tags, delivery_address, worklist_at, escalation_reason").in("status", NEEDS_PLACING).is("deleted_at", null),
    sb.from("order_assignments").select("order_id, sla_deadline_at").in("status", LIVE_OFFER),
    sb.from("orders").select("id, order_name, status, delivery_at, tags, delivery_address, worklist_at").eq("status", "reaching_out").is("deleted_at", null),
    sb.from("orders").select("id, order_name, status, delivery_at, tags, delivery_address, worklist_at").in("status", IN_FULFILMENT).lt("delivery_at", nowIso).is("deleted_at", null),
    sb.from("order_issues").select("id, order_id, type, cx_unread").eq("status", "open"),
    sb.from("payouts").select("id, assignment_id, leg, status, dispute_status").or("status.eq.failed,status.eq.held,dispute_status.not.is.null"),
    sb.from("outbox").select("order_id, kind").eq("status", "dead"),
    sb.from("order_approvals").select("order_id, kind").eq("status", "pending"),
    // Shopify says the order is fulfilled/archived while one of our florists is
    // still holding it. refreshFromShopify (ingest-worker/src/lateMatch.ts)
    // deliberately does NOT close these — an accept-leg payout is already issued
    // — so a human has to settle who actually delivered it, via the order page's
    // resolve action (app/api/orders/shopify-conflict/{close,dismiss}) — both
    // outcomes write a `shopify_conflict_resolved` event, which drops the order
    // out of this list (lib/shopifyConflict.ts::unresolvedConflictOrderIds).
    sb.from("order_events").select("order_id, type").in("type", [CONFLICT_EVENT, CONFLICT_RESOLVED_EVENT]),
    // A support conversation the agent refused to answer. Until now these set
    // cx_unread and sat on /conversations only, which meant the desk — the page
    // CX actually works from — had no idea a florist was waiting. Order-scoped
    // ones belong here with everything else about that order.
    sb.from("conversations")
      .select("order_id, escalation_reason, last_inbound_at")
      .eq("kind", "support")
      .eq("status", "awaiting_human")
      .not("order_id", "is", null),
    // Candidate assignments for rule 9 below — just the ids here; the full
    // per-assignment history (needed to find each one's MOST RECENT verdict)
    // is fetched after, scoped to only these ids.
    sb.from("photo_verifications").select("assignment_id").in("verdict", ["review", "fail"]),
  ]);
  // Same working-set gate as the ingest worker's match step
  // (dashboard/lib/orderTags.ts::isInWorkingSet) — an order outside the working
  // set never got matched in the first place, so keep it out of the CX queue too
  // rather than flooding it with orders nobody is meant to be working yet.
  const workingSetCriteria: WorkingSetCriteria = {
    activeOrderTags: (settings.data?.active_order_tags as string[] | null) ?? [],
    activeOrderCountries: (settings.data?.active_order_countries as string[] | null) ?? [],
    runAllOrders: (settings.data?.run_all_orders as boolean | null) ?? false,
  };

  (statusOrders.data ?? []).forEach(remember);
  (reachingOrders.data ?? []).forEach(remember);
  (lateOrders.data ?? []).forEach(remember);

  // 1. Can't place — escalated (no florist) / awaiting reach-out.
  for (const o of statusOrders.data ?? []) {
    add(o.id, placementAttentionReason(o.status, o.delivery_at, o.escalation_reason));
  }
  // 2. Offers — a live offer past its SLA is stalling; also track which orders
  //    currently have an active offer so we can spot cold waves in 2b.
  const activeOfferOrders = new Set<string>();
  for (const a of liveOffers.data ?? []) {
    activeOfferOrders.add(a.order_id);
    if (a.sla_deadline_at && a.sla_deadline_at < nowIso) {
      add(a.order_id, { category: "place", label: "Offer stalling — SLA breached", urgency: 100 + overdueBonus(a.sla_deadline_at), slaAt: a.sla_deadline_at });
    }
  }
  // 2b. Cold wave — an order in reach-out with NO active offer (last candidate
  //     declined/expired, nobody currently being offered). Needs CX to advance
  //     to the next florist; otherwise it's silently stuck.
  for (const o of reachingOrders.data ?? []) {
    if (!activeOfferOrders.has(o.id)) {
      add(o.id, { category: "place", label: "Needs next florist — no live offer", urgency: 85, slaAt: o.delivery_at });
    }
  }
  // 2d. Engaged, then silent — a shop that opened or clicked an offer which
  //     then expired, on an order still unplaced. That shop is the warmest
  //     lead CX has; see cxAttentionRules.ts::isHumanEngagement for how a
  //     person is told apart from a mail scanner, and for order #2000034.
  //     Scoped to working-set orders up front, not just filtered at the end,
  //     because this rule issues queries per order id and the unplaced
  //     backlog outside the working set is large.
  const unplacedInWorkingSet = [...(statusOrders.data ?? []), ...(reachingOrders.data ?? [])]
    .filter((o: Row) => isInWorkingSet({
      tags: o.tags ?? null,
      deliveryCountry: extractDeliveryCountry(o.delivery_address ?? null),
      deliveryAt: o.delivery_at ?? null,
      hasExplicitPick: o.worklist_at != null,
    }, workingSetCriteria))
    .map((o: Row) => o.id as string);
  for (const orderId of await engagedThenSilentOrderIds(sb, unplacedInWorkingSet)) {
    add(orderId, ENGAGED_THEN_SILENT_REASON);
  }
  // 2c. Step-mode (semi): a system transition waiting for a human to approve/edit/
  //     reject before it fires. The loop-advancing kinds (match/offer/reassign/
  //     escalate) block progress → high urgency; the notify/writeback kinds are
  //     lower. Nothing moves until someone acts.
  for (const a of offerApprovals.data ?? []) {
    const { label, urgency } = APPROVAL_ATTENTION[a.kind as string] ?? { label: "Approve pending step", urgency: 80 };
    add(a.order_id, { category: "approval", label, urgency, slaAt: null });
  }
  // 3. Late delivery.
  for (const o of lateOrders.data ?? []) {
    add(o.id, { category: "delivery", label: "Late — past the delivery window", urgency: 85 + overdueBonus(o.delivery_at), slaAt: o.delivery_at });
  }
  // 4. Florist issues + unread messages. (A client "never arrived" dispute type
  //    isn't in the order_issues schema yet — card disputes are surfaced via
  //    payouts.dispute_status in step 5; a dispute-intake feature is future.)
  for (const i of issues.data ?? []) {
    add(i.order_id, { category: "message", label: issueLabel("en", i.type), urgency: i.cx_unread ? 65 : 50, slaAt: null, unread: !!i.cx_unread });
  }
  // 5. Money — failed payouts / card disputes (map assignment → order).
  const payoutRows = moneyPayouts.data ?? [];
  if (payoutRows.length) {
    const aids = [...new Set(payoutRows.map((p: Row) => p.assignment_id).filter(Boolean))];
    const { data: asg } = aids.length ? await sb.from("order_assignments").select("id, order_id").in("id", aids) : { data: [] as Row[] };
    const aToO = new Map((asg ?? []).map((a: Row) => [a.id, a.order_id]));

    // A held row's reason (tier-hold / provisional-shop / delivery-gate, or
    // the legacy photo-verdict on a row parked before that hold was disabled
    // 2026-08-20) so the desk can show WHY, not just "held" — the same
    // reason sweepHeldPayouts reads to decide whether to release it for us.
    const heldIds = payoutRows.filter((p: Row) => p.status === "held").map((p: Row) => p.id);
    const { data: heldEvents } = heldIds.length
      ? await sb.from("payment_events").select("payout_id, payload, created_at").eq("type", "held_for_review").in("payout_id", heldIds).order("created_at", { ascending: false })
      : { data: [] as Row[] };
    const reasonByPayout = new Map<string, string | null>();
    for (const e of heldEvents ?? []) {
      if (!reasonByPayout.has(e.payout_id)) reasonByPayout.set(e.payout_id, e.payload?.reason ?? null);
    }

    for (const p of payoutRows) {
      const oid = aToO.get(p.assignment_id);
      if (!oid) continue;
      if (p.status === "held") {
        const pct = p.leg === "accept" ? "70%" : "30%";
        const reason = reasonByPayout.get(p.id);
        const why = (reason && HELD_REASON_LABEL[reason]) || "review needed";
        add(oid, { category: "money", label: `${pct} held — ${why}`, urgency: 75, slaAt: null, dedupeKind: "held_payout" });
      }
      if (p.status === "failed") add(oid, { category: "money", label: "Payout failed", urgency: 72, slaAt: null });
      if (p.dispute_status) add(oid, { category: "money", label: `Card dispute (${p.dispute_status})`, urgency: 70, slaAt: null });
    }
  }

  // 6. Effects that exhausted their retries (dead outbox rows) — a payout /
  //    write-back that never went through and needs a human to settle.
  for (const e of deadEffects.data ?? []) {
    if (!e.order_id) continue;
    const label = e.kind === "payout" ? "Payout stuck — retries exhausted, settle manually" : `Effect stuck (${e.kind})`;
    add(e.order_id, { category: "money", label, urgency: 78, slaAt: null });
  }

  // 7. Shopify closed the order out from under a florist who is still holding it.
  //    High urgency and money-flavoured: someone is owed, or owes us, a decision.
  //    Excludes anything already resolved from the order page (either outcome).
  for (const orderId of unresolvedConflictOrderIds(shopifyConflicts.data ?? [])) {
    add(orderId, {
      category: "money",
      label: "Shopify shows this fulfilled — but our florist still holds it",
      urgency: 82,
      slaAt: null,
    });
  }

  // 8. A florist is waiting on a person in a support thread.
  //
  //    Urgency sits just above an unread order issue: someone typed a question
  //    and got told a colleague would answer, which is a promise with a clock
  //    on it. Always `unread` — an escalated thread that nobody has replied to
  //    is by definition unattended.
  for (const c of escalatedThreads.data ?? []) {
    if (!c.order_id) continue;
    add(c.order_id, {
      category: "message",
      label: `Florist waiting on a reply${c.escalation_reason ? ` (${c.escalation_reason})` : ""}`,
      urgency: 68,
      slaAt: null,
      unread: true,
    });
  }

  // 9. AI photo check couldn't decide, or said no. This verdict no longer
  //    holds the payout (lib/payoutHold.ts, disabled 2026-08-20 pending
  //    recalibration) — see cxAttentionRules.ts's header on this rule for why
  //    that is deliberately left alone here; this only adds the visibility
  //    that was missing, same as every other rule in this function.
  const badAssignmentIds = [...new Set((badPhotoVerdicts.data ?? []).map((p: Row) => p.assignment_id as string).filter(Boolean))];
  if (badAssignmentIds.length) {
    const verifications = await selectIn(badAssignmentIds, (chunk) =>
      sb.from("photo_verifications").select("order_id, assignment_id, verdict, created_at").in("assignment_id", chunk)
    );
    for (const { orderId, reason } of photoVerdictAttentionReasons(
      verifications.map((p: Row) => ({ assignmentId: p.assignment_id, orderId: p.order_id, verdict: p.verdict, createdAt: p.created_at }))
    )) {
      add(orderId, reason);
    }
  }

  // Fill in order info for orders only referenced by assignment/payout/effect (no name yet).
  //
  // `.is("deleted_at", null)` matters here and is easy to miss: every query
  // ABOVE filters deleted orders at source, but the money/message paths reach
  // an order indirectly (payout → assignment → order_id), so a soft-deleted
  // order carrying a held payout arrived through this backfill and showed up
  // on the desk as if it were live. Deleting it in the UI did nothing. Found
  // 2026-09-01 while retiring stale QA orders off the Operator panel.
  const missing = [...byOrder.keys()].filter((id) => !info.has(id));
  if (missing.length) {
    const { data: more } = await sb
      .from("orders")
      .select("id, order_name, status, delivery_at, tags, delivery_address, worklist_at")
      .in("id", missing)
      .is("deleted_at", null);
    (more ?? []).forEach(remember);
  }

  const rows: CxAttentionRow[] = [];
  for (const [orderId, reasons] of byOrder.entries()) {
    const meta = info.get(orderId);
    // No order row behind the reason: it was deleted (the backfill above
    // filters those out) or it no longer exists. Either way there is nothing a
    // human can open, so it must not become a row.
    if (!meta) continue;
    const deliveryCountry = extractDeliveryCountry(meta.delivery_address);
    if (!isInWorkingSet({
      tags: meta.tags,
      deliveryCountry,
      deliveryAt: meta.delivery_at,
      hasExplicitPick: meta.worklist_at != null,
    }, workingSetCriteria)) continue; // out of the working set — never matched, keep out of CX
    reasons.sort((a, b) => b.urgency - a.urgency);
    rows.push({
      orderId,
      orderName: meta.order_name,
      deliveryAt: meta.delivery_at,
      status: meta.status,
      primary: reasons[0],
      others: reasons.slice(1),
      categories: [...new Set(reasons.map((r) => r.category))],
      unread: reasons.some((r) => r.unread),
      urgency: reasons[0].urgency,
    });
  }
  rows.sort((a, b) => {
    if (b.urgency !== a.urgency) return b.urgency - a.urgency;
    const ad = a.deliveryAt ?? "9999", bd = b.deliveryAt ?? "9999";
    return ad < bd ? -1 : ad > bd ? 1 : 0;
  });
  return rows;
}

// PostgREST sends `.in()` filters in the URL, so a long id list can exceed the
// request line limit and fail the whole desk. Batched rather than trusted.
const IN_CHUNK = 100;
async function selectIn(ids: string[], run: (chunk: string[]) => PromiseLike<{ data: Row[] | null }>): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data } = await run(ids.slice(i, i + IN_CHUNK));
    out.push(...(data ?? []));
  }
  return out;
}

/** Order ids (from `orderIds`) holding an expired or withdrawn offer that a
 * florist genuinely engaged with. Rule 2d of gatherAttention. */
async function engagedThenSilentOrderIds(sb: SupabaseClient, orderIds: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  if (!orderIds.length) return found;

  const assignments = await selectIn(orderIds, (chunk) =>
    sb.from("order_assignments").select("id, order_id, opened_at").in("order_id", chunk).in("status", ["expired", "withdrawn"])
  );
  if (!assignments.length) return found;

  const evidence = new Map<string, OfferEngagementEvidence>();
  for (const a of assignments) evidence.set(a.id, { openedAt: a.opened_at ?? null, clicks: [] });

  // A portal visit already settles it, so only fetch clicks where it does not.
  const needClicks = assignments.filter((a: Row) => !a.opened_at).map((a: Row) => a.id as string);
  if (needClicks.length) {
    const comms = await selectIn(needClicks, (chunk) =>
      sb.from("communications").select("id, assignment_id")
        .in("assignment_id", chunk).eq("channel", "email").in("kind", ["offer", "offer_renotify"]).eq("test_mode", false)
    );
    const commToAssignment = new Map<string, string>(comms.map((c: Row) => [c.id, c.assignment_id]));
    if (commToAssignment.size) {
      const events = await selectIn([...commToAssignment.keys()], (chunk) =>
        sb.from("email_events").select("communication_id, event_type, occurred_at")
          .in("communication_id", chunk).in("event_type", ["delivered", "clicked"])
      );
      const deliveredAt = new Map<string, string>();
      for (const e of events) {
        if (e.event_type !== "delivered") continue;
        const prev = deliveredAt.get(e.communication_id);
        if (!prev || e.occurred_at < prev) deliveredAt.set(e.communication_id, e.occurred_at);
      }
      for (const e of events) {
        if (e.event_type !== "clicked") continue;
        const assignmentId = commToAssignment.get(e.communication_id);
        if (!assignmentId) continue;
        evidence.get(assignmentId)?.clicks.push({ clickedAt: e.occurred_at, deliveredAt: deliveredAt.get(e.communication_id) ?? null });
      }
    }
  }

  const orderOf = new Map<string, string>(assignments.map((a: Row) => [a.id, a.order_id]));
  for (const [assignmentId, ev] of evidence) {
    const orderId = orderOf.get(assignmentId);
    if (orderId && isHumanEngagement(ev)) found.add(orderId);
  }
  return found;
}

// Badge count for the sidebar — distinct orders needing attention. Kept exactly
// consistent with the Control panel's table (same function) so the badge never disagrees with
// the list, and so it includes the cold-wave case that a per-signal head-count
// can't express. It re-runs gather on every staff page (the layout is dynamic);
// if that cost ever matters, move the distinct-order count into a SQL RPC.
export async function countAttention(sb: SupabaseClient): Promise<number> {
  return (await gatherAttention(sb)).length;
}
