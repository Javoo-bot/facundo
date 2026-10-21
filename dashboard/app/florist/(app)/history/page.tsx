import { floristReadContext } from "@/lib/floristView";
import FloristHistory, { type HistoryRow } from "@/components/florist/FloristHistory";

export const dynamic = "force-dynamic";

// Order statuses that mean an "accepted" assignment has run its course —
// delivered/paid/closed (completed) or cancelled — and belongs in history
// rather than the live Orders tab.
const CLOSED_ORDER_STATUSES = new Set(["delivered", "paid", "closed", "cancelled"]);

export default async function FloristHistoryPage() {
  const ctx = await floristReadContext();
  if (!ctx) return null; // layout gates; defensive
  let q = ctx.db
    .from("order_assignments")
    .select(
      "id, status, payout_price, assigned_at, orders(order_name, delivery_at, status)"
    )
    .in("status", ["delivered", "declined", "expired", "reassigned", "released", "accepted"]);
  if (ctx.scope) q = q.eq("florist_id", ctx.floristId);
  const { data } = await q.order("assigned_at", { ascending: false });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase join shape (orders(...)) is untyped here
  const rows = ((data ?? []) as any[]).filter((r) => {
    if (r.status !== "accepted") return true;
    return CLOSED_ORDER_STATUSES.has(r.orders?.status ?? "");
  }) as HistoryRow[];

  return <FloristHistory rows={rows} />;
}
