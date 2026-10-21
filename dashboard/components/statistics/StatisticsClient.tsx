"use client";
import { useCallback } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import DateRangePicker from "./DateRangePicker";
import OrdersSection from "./OrdersSection";
import AcceptanceSection from "./AcceptanceSection";
import FulfilmentSection from "./FulfilmentSection";
import IssuesSection from "./IssuesSection";
import UsageSection from "./UsageSection";
import LoginsSection from "./LoginsSection";
import MessagingSection from "./MessagingSection";
import FunnelSection from "./FunnelSection";
import StatsChat from "./StatsChat";
import type {
  StatsRange, OrdersStats, AcceptanceStats, FulfilmentStats, IssuesStats, UsageStats, LoginStats, MessagingStats, FunnelStats,
} from "@/lib/opsStats";
import { pageTitle } from "@/lib/brand";

export interface StatisticsData {
  orders: OrdersStats | null;
  acceptance: AcceptanceStats | null;
  fulfilment: FulfilmentStats | null;
  issues: IssuesStats | null;
  usage: UsageStats | null;
  logins: LoginStats | null;
  messaging: MessagingStats | null;
  funnel: FunnelStats | null;
}

/** Shown in place of a section whose query failed — a missing table on a deploy
 * where the migrations haven't been applied, but equally a timeout or any other
 * backend error. Deliberately says "unavailable" rather than showing zeroes:
 * the numbers this page carries get read as business facts, and "0 orders" is
 * the wrong thing to say when the truth is "we couldn't ask". The rest of the
 * page must survive it — see page.tsx's per-section catch. */
function SectionUnavailable({ title }: { title: string }) {
  return (
    <section style={{ display: "grid", gap: 12 }}>
      <div className="card" style={{ padding: 16, color: "var(--ink-faint)", fontSize: ".85rem" }}>
        <strong style={{ color: "var(--ink-soft)" }}>{title}</strong> is unavailable — its data couldn&rsquo;t be
        loaded, so nothing is shown rather than a misleading zero. Check the server log for the reason (a
        migration that hasn&rsquo;t been applied is the usual one).
      </div>
    </section>
  );
}

export default function StatisticsClient({
  range,
  data,
  activeDays,
}: {
  range: StatsRange;
  data: StatisticsData;
  /** Days the picker may offer; `null` when we couldn't find out. */
  activeDays: string[] | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Same pattern as OrdersClient: patch the URL and router.replace (no
  // history entry). The page is force-dynamic, so this re-runs the server
  // component with the new range and every section gets fresh props.
  const handleRangeChange = useCallback(
    (next: StatsRange) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("from", next.from);
      params.set("to", next.to);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  return (
    <div className="ds page" style={{ maxWidth: "var(--maxw-wide)", margin: "0 auto", padding: "24px 20px 60px", display: "grid", gap: 24 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <p className="eyebrow">Backoffice</p>
          <h1 style={{ fontSize: "1.4rem", fontWeight: 650, color: "var(--ink)" }}>{pageTitle("Statistics & Insights")}</h1>
        </div>
        <DateRangePicker value={range} onChange={handleRangeChange} activeDays={activeDays} />
      </div>

      <div>
        <h2 className="mini-h" style={{ marginBottom: 8 }}>Orders</h2>
        {data.orders ? <OrdersSection data={data.orders} /> : <SectionUnavailable title="Orders" />}
      </div>

      <div>
        <h2 className="mini-h" style={{ marginBottom: 8 }}>Acceptance &amp; refusals</h2>
        {data.acceptance ? <AcceptanceSection data={data.acceptance} /> : <SectionUnavailable title="Acceptance & refusals" />}
      </div>

      <div>
        <h2 className="mini-h" style={{ marginBottom: 8 }}>Fulfilment</h2>
        {data.fulfilment ? <FulfilmentSection data={data.fulfilment} /> : <SectionUnavailable title="Fulfilment" />}
      </div>

      <div>
        <h2 className="mini-h" style={{ marginBottom: 8 }}>Issues</h2>
        {data.issues ? <IssuesSection data={data.issues} /> : <SectionUnavailable title="Issues" />}
      </div>

      <div>
        <h2 className="mini-h" style={{ marginBottom: 8 }}>Usage</h2>
        {data.usage ? <UsageSection data={data.usage} /> : <SectionUnavailable title="Usage" />}
      </div>

      <div>
        <h2 className="mini-h" style={{ marginBottom: 8 }}>Logins</h2>
        {data.logins ? <LoginsSection data={data.logins} /> : <SectionUnavailable title="Logins" />}
      </div>

      <div>
        <h2 className="mini-h" style={{ marginBottom: 8 }}>Messaging</h2>
        {data.messaging ? <MessagingSection data={data.messaging} /> : <SectionUnavailable title="Messaging" />}
      </div>

      <div>
        {/* Per TOUCH — "which angle earns the click". The Visual funnel tab
            answers the other question, per SHOP: where we lose florists. */}
        <h2 className="mini-h" style={{ marginBottom: 8 }}>Outreach funnel, touch by touch</h2>
        {data.funnel ? <FunnelSection data={data.funnel} /> : <SectionUnavailable title="Outreach funnel" />}
        <p style={{ marginTop: 8, fontSize: ".76rem", color: "var(--ink-faint)" }}>
          For how many <em>shops</em> survive each step of the funnel, see the{" "}
          <strong>Visual funnel</strong> tab at the top of this page.
        </p>
      </div>

      <div>
        <h2 className="mini-h" style={{ marginBottom: 8 }}>Ask the data</h2>
        <StatsChat />
      </div>
    </div>
  );
}
