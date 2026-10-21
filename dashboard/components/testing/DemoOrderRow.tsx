"use client";

import { useState } from "react";
import Link from "next/link";
import Badge, { orderStatusBadge, assignmentStatusBadge } from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import { backofficeOrderPath, demoSplitViewPath, formatDemoIds } from "@/lib/testing/demoLinks";
import type { OrderStatus, AssignmentStatus } from "@/lib/orderStatus";
import type { DemoOrder } from "./OrderSandboxPanel";

function when(ts: string | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

/** One demo order's card: status badges, the id bundle, and the four presenter
 *  actions (open backoffice / open florist / copy ids / split view). Its own
 *  component so the per-row "minting the florist link" and "copied" states
 *  don't have to be lifted into arrays on the parent. */
export default function DemoOrderRow({ order }: { order: DemoOrder }) {
  const a = order.order_assignments[0];
  const [minting, setMinting] = useState(false);
  const [floristErr, setFloristErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const idBundle = formatDemoIds({ orderId: order.id, floristId: a?.florist_id ?? null, assignmentId: a?.id ?? null });

  async function openFloristScreen() {
    if (!a) return;
    setMinting(true);
    setFloristErr(null);
    try {
      const res = await fetch("/api/testing/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "florist_link", assignmentId: a.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.url) {
        setFloristErr(j.error || `Could not mint the florist link (${res.status}).`);
        return;
      }
      window.open(j.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setFloristErr(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setMinting(false);
    }
  }

  async function copyIds() {
    try {
      await navigator.clipboard.writeText(idBundle);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — the ids are printed on the card regardless.
    }
  }

  return (
    <li className="px-3 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-medium text-ink">🧪 {order.order_name ?? order.id.slice(0, 8)}</p>
        <Badge info={orderStatusBadge(order.status as OrderStatus)} />
        {a && <Badge info={assignmentStatusBadge(a.status as AssignmentStatus)} />}
        {order.demo_source_order_id && (
          <span className="text-xs text-ink-faint">cloned from {order.demo_source_order_id.slice(0, 8)}</span>
        )}
      </div>
      <p className="mt-0.5 text-xs text-ink-faint">{order.delivery_area ?? "—"} · created {when(order.created_at)}</p>
      {a && (
        <p className="mt-0.5 text-xs text-ink-soft">
          payout €{a.payout_price ?? "—"}
          {a.offer_expires_at ? ` · expires ${when(a.offer_expires_at)}` : ""}
          {a.accepted_at ? ` · accepted ${when(a.accepted_at)}` : ""}
          {a.delivered_at ? ` · delivered ${when(a.delivered_at)}` : ""}
        </p>
      )}
      <p className="mt-1 font-mono text-[11px] text-ink-faint">
        order {order.id.slice(0, 8)}
        {a?.florist_id ? ` · florist ${a.florist_id.slice(0, 8)}` : ""}
        {a?.id ? ` · assignment ${a.id.slice(0, 8)}` : ""}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Link href={backofficeOrderPath(order.id)} target="_blank" rel="noopener noreferrer" className="btn">
          Open backoffice order ↗
        </Link>
        <Button
          type="button"
          variant="default"
          disabled={!a || minting}
          title={!a ? "No assignment on this order — nothing to view as a florist." : undefined}
          onClick={() => void openFloristScreen()}
        >
          {minting ? "Minting…" : "Open florist screen (read-only view-as) ↗"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => void copyIds()}>
          {copied ? "Copied" : "Copy IDs"}
        </Button>
        <Link href={demoSplitViewPath(order.id)} className="btn btn-ghost">
          Split view
        </Link>
      </div>
      {floristErr && <p className="mt-1 text-xs text-crit">{floristErr}</p>}
    </li>
  );
}
