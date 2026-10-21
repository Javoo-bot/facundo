import HomeClient from "@/components/home/HomeClient";
import SignInScreen from "@/components/SignInScreen";
import { createServerClient } from "@/lib/supabase";
import { getSessionUser, getStaffAccess, getAttentionCached } from "@/lib/authCache";
import { deriveCity, deriveCountry } from "@/components/orders/orderDerive";
import { byDeadline } from "@/lib/operator";
import type { ControlRow } from "@/lib/controlPanel";
import type { AssignmentStatus, OrderStatus } from "@/lib/orderStatus";
import { workingSetConfig, workingSetOrClause } from "@/lib/workingSetServer";

export const dynamic = "force-dynamic";

const TERMINAL_COMPLETED = ["paid", "closed", "cancelled", "delivered"];

/** Escape the tiny subset of punctuation that PostgREST `.or()` treats as
 * syntax. Mirrors the Orders page helper so the Control panel can use the same
 * working-set SQL clause safely. */
function sanitizeForFilter(value: string): string {
  return value.replace(/[,%*()]/g, "").trim();
}

/**
 * The Control panel — one table, one question: WHICH ORDER DO I HANDLE FIRST?
 *
 * It now shows the whole non-terminal working set, not only rows that already
 * need CX attention. That is the product contract: if an order is in the
 * working set, the system is operating on it, so staff must be able to see it
 * here until it completes. Rows with a CX reason still carry that reason and
 * rise naturally by deadline; quiet rows get a neutral "In working set" reason.
 */
export default async function HomePage() {
  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed } = await getStaffAccess(user.email);
  if (!allowed) {
    const supabase = await createServerClient();
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }
  const supabase = await createServerClient();

  const [attnRowsRaw, wsConfig] = await Promise.all([
    getAttentionCached(),
    workingSetConfig(supabase),
  ]);
  const attnRows = byDeadline(attnRowsRaw);
  const attentionByOrder = new Map(attnRows.map((r) => [r.orderId, r]));

  // Working-set source of truth for the Control panel. The SQL clause includes:
  // - explicit manual picks (`worklist_at`) regardless of delivery date;
  // - automatic run-all/country/tag criteria only for future delivery dates.
  // Terminal orders are not shown here; the reconcile sweep also clears explicit
  // picks on terminal rows, but this filter makes the panel correct immediately.
  const gateClause = workingSetOrClause(wsConfig, sanitizeForFilter);
  const listSelect =
    "id, order_name, status, delivery_area, delivery_address, delivery_at, delivery_window, " +
    "order_assignments(status, withdrawn_at)";

  let detail: unknown[] = [];
  let detailError: unknown = null;
  if (gateClause) {
    const query = supabase
      .from("orders")
      .select(listSelect)
      .is("deleted_at", null)
      .not("status", "in", `(${TERMINAL_COMPLETED.join(",")})`)
      .or(gateClause)
      .order("delivery_at", { ascending: true, nullsFirst: false });
    const result = await query;
    detail = (result.data ?? []) as unknown[];
    detailError = result.error;
  }

  // Safety net: attention rows should already be inside the working set, but if
  // an indirect signal races with a setting/pick update, preserve the urgent row
  // instead of dropping a live CX item because the working-set list query missed
  // it for this request.
  const listedIds = new Set((detail as Record<string, unknown>[]).map((o) => o.id as string));
  const missingAttentionIds = attnRows.map((r) => r.orderId).filter((id) => !listedIds.has(id));
  if (!detailError && missingAttentionIds.length) {
    const extra = await supabase
      .from("orders")
      .select(listSelect)
      .in("id", missingAttentionIds)
      .is("deleted_at", null)
      .not("status", "in", `(${TERMINAL_COMPLETED.join(",")})`);
    detail.push(...((extra.data ?? []) as unknown[]));
    detailError = extra.error;
  }

  // supabase-js widens a select carrying an embed to a union with its error
  // shape, so the rows are narrowed here — the same cast /orders makes for the
  // same reason (see app/(staff)/orders/page.tsx).
  const detailRows = (detail ?? []) as Record<string, unknown>[];

  const rows: ControlRow[] = detailRows.map((d) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loosely-typed supabase row
    const row = d as any;
    const attention = attentionByOrder.get(row.id as string);
    const place = [deriveCity(row), deriveCountry(row)].filter((s) => s && s !== "—").join(", ");
    return {
      id: row.id as string,
      orderName: (row.order_name ?? attention?.orderName ?? null) as string | null,
      destination: place || "—",
      status: (row.status ?? attention?.status ?? "received") as OrderStatus,
      deliveryAt: (row.delivery_at ?? attention?.deliveryAt ?? null) as string | null,
      deliveryWindow: row.delivery_window ?? null,
      assignments: ((row.order_assignments ?? []) as { status: AssignmentStatus; withdrawn_at: string | null }[]).map(
        (a) => ({ status: a.status, withdrawnAt: a.withdrawn_at ?? null })
      ),
      reason: attention?.primary.label ?? "In working set — automation is tracking it",
      severity: attention ? (attention.urgency >= 80 ? "crit" : "warn") : "warn",
    };
  });

  return <HomeClient rows={byDeadline(rows.map((r) => ({
    orderId: r.id,
    orderName: r.orderName,
    deliveryAt: r.deliveryAt,
    status: r.status,
    primary: { category: "place", label: r.reason, urgency: r.severity === "crit" ? 80 : 40, slaAt: r.deliveryAt },
    others: [],
    categories: ["place"],
    unread: false,
    urgency: r.severity === "crit" ? 80 : 40,
  }))).map((sorted) => rows.find((r) => r.id === sorted.orderId)!).filter(Boolean)} fetchError={detailError != null} />;
}
