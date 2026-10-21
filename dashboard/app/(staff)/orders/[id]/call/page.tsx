import { createServerClient } from "@/lib/supabase";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import SignInScreen from "@/components/SignInScreen";
import CallCard, { type CallCardSubject, type CallCardHistory } from "@/components/orders/CallCard";
import { loadOrderCallData } from "@/lib/callCardData";
import { pickSubject, buildHistory, historySummary, offerLine, uncallableReason, isColdLead, noSubjectReason, lastCallLine, type HistoryRow } from "@/lib/callCard";
import { shortStamp, longDay, dueLabel, destinationLine, shopFacts, whoToAskFor } from "@/lib/callCardFormat";
import { formatMoney } from "@/components/orders/format";
import { formatKm } from "@/lib/geo";
import type { AssignmentStatus } from "@/lib/orderStatus";

export const dynamic = "force-dynamic";

/**
 * Who am I calling, and what am I asking them for.
 *
 * Reached from the Operator panel's "Contact a florist" button
 * (lib/operator.ts::operatorHref, the one action that routes off the order
 * page). One shop, one number, one thing to record afterwards — everything
 * else about the order is behind "Open full record".
 * `?shop=<assignmentId>` picks a specific candidate; without it the card opens
 * on the warmest one.
 */
export default async function CallPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ shop?: string }>;
}) {
  const { id } = await params;
  const { shop } = await searchParams;

  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed, role } = await getStaffAccess(user.email);
  if (!allowed) {
    const supabase = await createServerClient();
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }

  const data = await loadOrderCallData(id);
  if (!data) return <div style={{ padding: 24 }}>Order not found.</div>;
  const { order, items, ranked, assignmentStatuses } = data;

  const subject = pickSubject(ranked, shop ?? null);

  // Everything this shop has done with us, across every order — completed
  // orders and refusals only. A lapsed offer is not a refusal (see
  // lib/callCard.ts::buildHistory) and never appears.
  let history: CallCardHistory | null = null;
  if (subject) {
    const supabase = await createServerClient();
    const { data: rows } = await supabase
      .from("order_assignments")
      .select("id, order_id, status, decline_reason, decline_detail, declined_at, delivered_at")
      .eq("florist_id", subject.floristId);
    const list = rows ?? [];
    const orderIds = [...new Set(list.map((r) => r.order_id))];
    const { data: names } = orderIds.length
      ? await supabase.from("orders").select("id, order_name").in("id", orderIds)
      : { data: [] as { id: string; order_name: string | null }[] };
    const nameById = new Map((names ?? []).map((o) => [o.id, o.order_name]));

    const built = buildHistory(list.map((r): HistoryRow => ({
      assignmentId: r.id,
      orderId: r.order_id,
      orderName: nameById.get(r.order_id) ?? null,
      status: r.status as AssignmentStatus,
      declineReason: r.decline_reason,
      declineDetail: r.decline_detail,
      declinedAt: r.declined_at,
      deliveredAt: r.delivered_at,
    })));

    history = {
      summary: historySummary(built),
      refusals: built.refusals.map((r) => ({
        when: shortStamp(r.when),
        reason: r.reason,
        detail: r.detail,
        orderName: r.orderName,
        isThisOrder: r.orderId === order.id,
      })),
    };
  }

  const cardSubject: CallCardSubject | null = subject
    ? {
        assignmentId: subject.assignmentId,
        floristId: subject.floristId,
        name: subject.name,
        phone: subject.phone,
        coldLead: isColdLead(subject.lifecycleStage),
        facts: shopFacts(subject.rating, subject.reviewCount, formatKm(subject.distanceKm)),
        who: whoToAskFor(subject.ownerName),
        offerLine: offerLine(subject, (iso) => shortStamp(iso) ?? "an unknown date"),
        uncallable: uncallableReason(subject),
        lastCall: lastCallLine(subject),
        isHolder: subject.status === "accepted" || subject.status === "delivered",
      }
    : null;

  const item = items[0] ?? null;
  const extra = items.length - 1;
  const due = dueLabel(order.delivery_at, Date.now());
  const day = longDay(order.delivery_at);

  return (
    <div className="ds" style={{ minHeight: "100%" }}>
      <CallCard
        orderId={order.id}
        orderName={order.order_name ?? `#${order.id.slice(0, 8)}`}
        dueLabel={due?.text ?? null}
        dueTone={due?.overdue ? "crit" : "warn"}
        itemTitle={item?.title ?? null}
        itemSub={[item?.variant, extra > 0 ? `plus ${extra} more item${extra === 1 ? "" : "s"}` : null].filter(Boolean).join(", ") || null}
        itemImage={item?.image_url ?? null}
        destination={destinationLine(order.delivery_address, order.delivery_area)}
        whenLine={[day, order.recipient_name ? `for ${order.recipient_name}` : null].filter(Boolean).join(", ") || null}
        payout={subject?.payoutPrice != null ? formatMoney(subject.payoutPrice, order.currency) : null}
        subject={cardSubject}
        history={history}
        canAct={role === "ops" || role === "admin"}
        noSubjectNote={noSubjectReason(assignmentStatuses as AssignmentStatus[])}
      />
    </div>
  );
}
