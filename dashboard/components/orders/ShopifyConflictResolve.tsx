"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { OrderEvent } from "@/lib/types";
import { describeConflictCloseImpact } from "@/lib/shopifyConflict";
import Button from "@/components/ui/Button";

// The staff resolution for an unresolved `shopify_conflict` (Shopify reports
// the order fulfilled/archived while one of our florists still holds it) — see
// lib/shopifyConflict.ts and ingest-worker/src/shopifyLifecycle.ts::orderClosure.
// Only rendered by OrderDetailClient once it's established the conflict is
// unresolved (event exists, no `shopify_conflict_resolved` marker, our status
// isn't terminal) — this component just states the two facts and offers the
// two outcomes.
export default function ShopifyConflictResolve({
  orderId,
  conflictEvent,
  floristName,
  assignmentStatus,
  hasDeliveryPayout,
}: {
  orderId: string;
  conflictEvent: OrderEvent | undefined;
  floristName: string | null;
  assignmentStatus: "accepted" | "delivered" | null;
  hasDeliveryPayout: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"close" | "dismiss" | null>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const payload = (conflictEvent?.payload ?? null) as { fulfilled?: boolean; archived?: boolean } | null;
  const facts = payload?.fulfilled && payload?.archived ? "fulfilled and archived"
    : payload?.fulfilled ? "fulfilled"
    : payload?.archived ? "archived"
    : "closed"; // conservative fallback — the event's payload should always carry one of the above

  const impact = describeConflictCloseImpact({ assignmentStatus, floristName, hasDeliveryPayout });
  const anyBusy = busy !== null;

  async function run(action: "close" | "dismiss") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/orders/shopify-conflict/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId }),
      });
      if (!res.ok) { setError((await res.json().catch(() => ({}))).error ?? "Action failed."); return; }
      setConfirmingClose(false);
      router.refresh();
    } catch {
      setError("Network error — please retry.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card" style={{ borderColor: "var(--crit)", background: "color-mix(in srgb, var(--crit) 6%, transparent)" }}>
      <div className="mini-h" style={{ color: "var(--crit)", marginBottom: 6 }}>Shopify conflict — unresolved</div>
      <p style={{ fontSize: ".85rem", margin: 0 }}>
        Shopify reports this order <b>{facts}</b>, but {floristName ? <b>{floristName}</b> : "a florist"} is still holding it.
      </p>

      {!confirmingClose ? (
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <Button variant="warn" disabled={anyBusy} onClick={() => setConfirmingClose(true)}>
            Accept Shopify&apos;s truth — close order
          </Button>
          <Button variant="ghost" disabled={anyBusy} onClick={() => run("dismiss")}>
            {busy === "dismiss" ? "Dismissing…" : "Keep ours — dismiss"}
          </Button>
        </div>
      ) : (
        <div style={{ marginTop: 10, border: "1px solid var(--crit)", borderRadius: 8, padding: 12, background: "color-mix(in srgb, var(--crit) 10%, transparent)" }}>
          <p style={{ fontSize: ".85rem", margin: 0 }}>
            This closes the order.{impact.warning ? ` ${impact.warning}` : ""}
          </p>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <Button variant="warn" disabled={anyBusy} onClick={() => run("close")}>
              {busy === "close" ? "Closing…" : "Confirm — close order"}
            </Button>
            <Button variant="ghost" disabled={anyBusy} onClick={() => setConfirmingClose(false)}>Cancel</Button>
          </div>
        </div>
      )}
      {error && <div style={{ color: "var(--crit)", fontSize: ".82rem", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
