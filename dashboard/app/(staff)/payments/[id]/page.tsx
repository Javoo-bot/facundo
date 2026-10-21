import Link from "next/link";
import { notFound } from "next/navigation";
import SignInScreen from "@/components/SignInScreen";
import Forbidden from "@/components/Forbidden";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import { createServerClient } from "@/lib/supabase";
import StaffCardActions from "@/components/payments/StaffCardActions";
import AdjustCardLimitAction from "@/components/payments/AdjustCardLimitAction";
import PaymentEventTimeline from "@/components/payments/PaymentEventTimeline";
import RetryPayoutAction from "@/components/payments/RetryPayoutAction";
import LiveAirwallexPanel from "@/components/payments/LiveAirwallexPanel";
import { airwallexCardUrl, airwallexCardTransactionsUrl } from "@/lib/airwallex/links";

export const dynamic = "force-dynamic";

function money(a: number | null | undefined, ccy: string | null | undefined): string {
  if (a == null || Number.isNaN(a)) return "—";
  return ccy ? `${a.toFixed(2)} ${ccy}` : a.toFixed(2);
}
function dt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? "—" : new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
const STATUS_BADGE: Record<string, string> = {
  paid: "badge-accent", issued: "badge-accent", pending: "badge-neutral", failed: "badge-crit", clawed_back: "badge-warn",
};
const LEG_LABEL: Record<string, string> = { accept: "On accept", delivery: "On delivery", manual: "Manual" };

export default async function PaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed, role } = await getStaffAccess(user.email);
  const supabase = await createServerClient();
  if (!allowed) {
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }
  if (role !== "finance" && role !== "admin") {
    return <Forbidden reason="Payments is only available to Finance and Admin roles." />;
  }

  const { data: payout } = await supabase
    .from("payouts")
    .select("*, order_assignments(order_id, florist_id, orders(order_name, currency), florists(name, trust_tier))")
    .eq("id", id)
    .single();
  if (!payout) notFound();

  const { data: events } = await supabase
    .from("payment_events")
    .select("type, payload, created_at")
    .eq("payout_id", id)
    .order("created_at", { ascending: true });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested join is untyped
  const a = (payout as any).order_assignments ?? {};
  const orderId = a.order_id ?? null;
  const orderName = a.orders?.order_name ?? null;
  const ccy = payout.currency ?? a.orders?.currency ?? null;
  const realCard = payout.rail === "card" && payout.provider_ref && !String(payout.provider_ref).startsWith("ledger:");
  const cardUrl = realCard ? airwallexCardUrl(payout.provider_ref) : null;
  const txnUrl = payout.last_txn_id ? airwallexCardTransactionsUrl() : null;

  return (
    <main className="ds page" style={{ display: "grid", gap: 16 }}>
      <Link href="/payments" className="eyebrow">← Payments</Link>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <h1>{money(payout.amount, ccy)}</h1>
        <span className={`badge ${STATUS_BADGE[payout.status] ?? "badge-neutral"}`}>{payout.status}</span>
      </div>

      <div className="card">
        <div className="mini-h" style={{ marginBottom: 10 }}>Payout</div>
        <dl className="kv">
          <dt>Leg</dt><dd>{LEG_LABEL[payout.leg] ?? payout.leg}</dd>
          <dt>Amount</dt><dd>{money(payout.amount, ccy)}</dd>
          <dt>Rail</dt><dd>{payout.rail ?? "—"}</dd>
          <dt>Status</dt><dd>{payout.status}</dd>
          <dt>Order</dt><dd>{orderId ? <Link href={`/orders/${orderId}`}>{orderName ?? orderId.slice(0, 8)}</Link> : "—"}</dd>
          <dt>Florist</dt><dd>{a.florist_id ? <Link href={`/florists/${a.florist_id}`}>{a.florists?.name ?? a.florist_id.slice(0, 8)}</Link> : "—"}</dd>
          <dt>Created</dt><dd>{dt(payout.created_at)}</dd>
          <dt>Updated</dt><dd>{dt(payout.updated_at)}</dd>
        </dl>
      </div>

      <div className="card">
        <div className="mini-h" style={{ marginBottom: 10 }}>Card &amp; transaction</div>
        <dl className="kv">
          <dt>Card status</dt><dd>{payout.card_status ?? (realCard ? "ACTIVE" : "—")}</dd>
          <dt>Spent</dt><dd>{payout.spent_amount != null ? money(payout.spent_amount, ccy) : "—"}</dd>
          <dt>Settled</dt><dd>{dt(payout.settled_at)}</dd>
          <dt>Transaction</dt><dd style={{ fontFamily: "var(--mono)", fontSize: ".8rem" }}>{payout.last_txn_id ?? "—"}</dd>
          {payout.dispute_status && (<><dt>Dispute</dt><dd><span className="badge badge-crit">{payout.dispute_status}</span></dd></>)}
        </dl>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10 }}>
          {cardUrl && <a href={cardUrl} target="_blank" rel="noopener noreferrer" className="link-subtle">View card in Airwallex ↗</a>}
          {txnUrl && <a href={txnUrl} target="_blank" rel="noopener noreferrer" className="link-subtle">View transactions ↗</a>}
        </div>
        {/* The fields above come from `payouts`, which only the Airwallex webhook
            ever writes — so they go stale silently when a webhook isn't delivered.
            This reads the card straight from Airwallex and names any disagreement. */}
        {realCard && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
            <div className="mini-h" style={{ marginBottom: 6 }}>Live from Airwallex</div>
            <LiveAirwallexPanel payoutId={payout.id} />
          </div>
        )}
        {/* Card ops moved here from the ledger */}
        {realCard && (
          <div style={{ marginTop: 12 }}>
            <div className="mini-h" style={{ marginBottom: 6 }}>Actions</div>
            <StaffCardActions payoutId={payout.id} cardStatus={payout.card_status} />
            <div style={{ marginTop: 8 }}>
              <AdjustCardLimitAction
                payoutId={payout.id}
                currentAmount={payout.amount}
                currency={ccy}
                cardStatus={payout.card_status}
                payoutStatus={payout.status}
              />
            </div>
          </div>
        )}
        {payout.status === "failed" && (
          <div style={{ marginTop: 12 }}>
            <div className="mini-h" style={{ marginBottom: 6 }}>Actions</div>
            <RetryPayoutAction payoutId={payout.id} />
          </div>
        )}
      </div>

      <div className="card">
        <div className="mini-h" style={{ marginBottom: 10 }}>Events</div>
        <PaymentEventTimeline events={(events ?? []) as { type: string; payload: unknown; created_at: string }[]} />
      </div>
    </main>
  );
}
