import { createServiceClient } from "@/lib/supabaseAdmin";
import { floristReadContext } from "@/lib/floristView";
import FloristBalance from "@/components/florist/FloristBalance";
import { computeEarnings, standingFor } from "@/lib/floristStanding";
import { isSinglePayment } from "@/lib/payoutMath";
import type { Payout } from "@/lib/types";
export const dynamic = "force-dynamic";
export default async function BalancePage() {
  const ctx = await floristReadContext();
  if (!ctx) return null; // layout gates; defensive
  // Payouts key off assignment_id (no florist_id column). RLS scopes them to the
  // florist; in view-as we scope by the florist's assignment ids.
  let pq = ctx.db.from("payouts").select("*");
  if (ctx.scope) pq = pq.in("assignment_id", ctx.scope.assignmentIds);
  const { data } = await pq.order("created_at", { ascending: false });
  const payouts = (data ?? []) as Payout[];

  // Standing + completed-order count come from the florist's own row + their
  // delivered assignments. The `florists` table is staff-scoped under RLS, so
  // read the tier via the service client keyed on this florist's id.
  const admin = createServiceClient();
  const [{ data: fl }, { count }] = await Promise.all([
    admin.from("florists").select("trust_tier").eq("id", ctx.floristId).maybeSingle(),
    admin.from("order_assignments").select("id", { count: "exact", head: true }).eq("florist_id", ctx.floristId).eq("status", "delivered"),
  ]);
  const tierCode: string | null = (fl?.trust_tier as string | null) ?? null;
  const completedCount = count ?? 0;
  // Whether this florist is paid in one go. Read from the tier ROW, not inferred
  // from the code: tier 1's split was changed to 100/0 in the database while
  // every screen still described a 70/30 deal, and a code-keyed lookup is what
  // let that pass unnoticed. See lib/payoutMath.ts::isSinglePayment.
  let singlePayment = false;
  if (tierCode) {
    const { data: tier } = await admin
      .from("trust_tiers")
      .select("split_on_delivery")
      .eq("code", tierCode)
      .maybeSingle();
    if (tier) singlePayment = isSinglePayment(tier);
  }

  return (
    <FloristBalance
      payouts={payouts}
      earnings={computeEarnings(payouts)}
      completedCount={completedCount}
      standing={standingFor(tierCode, { singlePayment })}
    />
  );
}
