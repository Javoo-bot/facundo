import Link from "next/link";
import { notFound } from "next/navigation";
import CardReveal from "@/components/florist/CardReveal";
import { currentFloristLocale } from "@/lib/floristAuth";
import { floristReadContext } from "@/lib/floristView";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

function euro(a: number | null | undefined): string {
  return a == null || Number.isNaN(a) ? "—" : `€${a.toFixed(2)}`;
}

export default async function FloristPaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const locale = await currentFloristLocale();
  const LEG_LABEL: Record<string, string> = {
    accept: t(locale, "ui.balance.payment.legAccept"),
    delivery: t(locale, "ui.balance.payment.legDelivery"),
  };
  // RLS scopes payouts to the signed-in florist, so a foreign / unknown id
  // simply isn't returned. Under a staff view-as session (service client) we
  // enforce ownership explicitly against the florist's assignment set.
  const ctx = await floristReadContext();
  if (!ctx) notFound();
  const { data: payout } = await ctx.db
    .from("payouts")
    .select("*, order_assignments(order_id, orders(order_name))")
    .eq("id", id)
    .maybeSingle();
  if (!payout || (ctx.scope && !ctx.scope.assignmentIds.includes(payout.assignment_id))) notFound();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- nested join is untyped
  const a = (payout as any).order_assignments ?? {};
  const revealable =
    payout.rail === "card" &&
    !!payout.provider_ref &&
    !String(payout.provider_ref).startsWith("ledger:") &&
    (payout.status === "issued" || payout.status === "paid");

  return (
    <main className="ds page fc-readable" style={{ display: "grid", gap: 14 }}>
      <Link href="/florist/balance" className="eyebrow">← {t(locale, "ui.balance.payment.backToBalance")}</Link>
      <h1>{euro(payout.amount)}</h1>
      <div className="ocard" style={{ display: "grid", gap: 8 }}>
        <div className="tx"><span>{t(locale, "ui.balance.payment.leg")}</span><b>{LEG_LABEL[payout.leg] ?? payout.leg}</b></div>
        <div className="tx"><span>{t(locale, "ui.balance.payment.status")}</span><b>{payout.status}</b></div>
        <div className="tx"><span>{t(locale, "ui.balance.payment.method")}</span><b>{payout.rail === "card" ? t(locale, "ui.balance.payment.virtualCard") : payout.rail ?? "—"}</b></div>
        {payout.assignment_id && (
          <div className="tx">
            <span>{t(locale, "ui.balance.payment.order")}</span>
            {/* The florist order route is keyed by the ASSIGNMENT id, not orders.id. */}
            <Link href={`/florist/orders/${payout.assignment_id}`}>{a.orders?.order_name ?? t(locale, "ui.balance.payment.viewOrder")}</Link>
          </div>
        )}
      </div>

      {revealable ? (
        <div className="ocard" style={{ display: "grid", gap: 6 }}>
          <div className="mini-h">{t(locale, "ui.balance.payment.yourCard")}</div>
          <p style={{ fontSize: ".82rem", color: "var(--ink-soft)" }}>{t(locale, "ui.balance.payment.revealNote")}</p>
          <CardReveal payoutId={payout.id} />
        </div>
      ) : payout.status === "clawed_back" ? (
        <p style={{ color: "var(--ink-faint)", fontSize: ".85rem" }}>{t(locale, "ui.balance.payment.reversedNote")}</p>
      ) : payout.rail === "card" ? (
        <p style={{ color: "var(--ink-faint)", fontSize: ".85rem" }}>{t(locale, "ui.balance.payment.noCardNote")}</p>
      ) : (
        /* The LEDGER rail: real money, recorded, with no card behind it yet.
           This branch used to be `null`, so a florist who tapped through from
           "issued EUR 41.00" hoping to find their card got a page that said
           nothing at all about why there wasn't one. It is not a rare state —
           every payout takes this rail while `app_settings.payments_live` is
           off, and a shop we own always does (lib/payoutMath.ts::
           effectivePaymentsLive). Same wording as the celebration modal's
           cardComingSoon, so the two surfaces cannot tell different stories. */
        <p style={{ color: "var(--ink-faint)", fontSize: ".85rem" }}>{t(locale, "ui.balance.payment.ledgerNote")}</p>
      )}
    </main>
  );
}
