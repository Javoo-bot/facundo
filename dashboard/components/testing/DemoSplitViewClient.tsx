"use client";

import { useState } from "react";
import Link from "next/link";
import Badge, { orderStatusBadge, assignmentStatusBadge } from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import type { OrderStatus, AssignmentStatus } from "@/lib/orderStatus";

interface DemoOrderSummary {
  id: string;
  order_name: string | null;
  status: string;
  delivery_area: string | null;
  demo_source_order_id: string | null;
}

interface DemoAssignmentSummary {
  id: string;
  florist_id: string;
  status: string;
  payout_price: number | null;
  offer_expires_at: string | null;
  accepted_at: string | null;
  delivered_at: string | null;
}

/**
 * Presenter split view for one demo order: two cards side by side, one linking
 * to the real backoffice order page, one minting the real florist magic link.
 * No iframes — see the server page's comment for why.
 */
export default function DemoSplitViewClient({
  order,
  assignment,
  backofficePath,
  floristReferencePath,
  idBundle,
}: {
  order: DemoOrderSummary;
  assignment: DemoAssignmentSummary | null;
  backofficePath: string;
  floristReferencePath: string | null;
  idBundle: string;
}) {
  const [minting, setMinting] = useState(false);
  const [floristMsg, setFloristMsg] = useState<string | null>(null);
  const [floristErr, setFloristErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function openFloristScreen() {
    if (!assignment) return;
    setMinting(true);
    setFloristErr(null);
    setFloristMsg(null);
    try {
      const res = await fetch("/api/testing/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "florist_link", assignmentId: assignment.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.url) {
        setFloristErr(j.error || `Could not mint the florist link (${res.status}).`);
        return;
      }
      window.open(j.url, "_blank", "noopener,noreferrer");
      setFloristMsg("Opened in a new tab — read-only view-as, so nothing you click there writes anything.");
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
      // Clipboard unavailable — the ids are already visible on the page.
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <Link href="/testing" className="text-sm font-medium text-accent hover:underline">
        ← Back to Demo Control Room
      </Link>

      <p className="eyebrow mt-4">Demo Control Room · Split view</p>
      <h1 className="mt-1 text-lg font-semibold text-ink">
        🧪 {order.order_name ?? order.id.slice(0, 8)}
      </h1>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
        <Badge info={orderStatusBadge(order.status as OrderStatus)} />
        {assignment && <Badge info={assignmentStatusBadge(assignment.status as AssignmentStatus)} />}
        <span>{order.delivery_area ?? "—"}</span>
        {order.demo_source_order_id && <span>· cloned from {order.demo_source_order_id.slice(0, 8)}</span>}
      </p>

      <div className="mt-3 rounded-md border border-line bg-surface-soft px-3 py-2 text-xs text-ink-soft">
        <p className="font-semibold text-ink">For the presenter</p>
        <p className="mt-1">
          Open both cards below in separate tabs before you start talking. Left is exactly what staff see for a
          real order; right is exactly what the florist sees, minted as a real (read-only, view-as) magic link —
          neither is a mock-up. Point out the status badges updating in sync as you drive the scenario from{" "}
          <Link href="/testing" className="underline">/testing</Link>.
        </p>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Card>
          <p className="eyebrow">Backoffice view</p>
          <h2 className="mt-1 text-sm font-semibold text-ink">What staff see</h2>
          <p className="mt-1 text-xs text-ink-soft">
            The real order detail page — matching candidates, offer wave, payouts, timeline.
          </p>
          <Link href={backofficePath} target="_blank" rel="noopener noreferrer" className="btn btn-solid mt-3">
            Open backoffice order ↗
          </Link>
        </Card>

        <Card>
          <p className="eyebrow">Florist view</p>
          <h2 className="mt-1 text-sm font-semibold text-ink">What the demo shop sees</h2>
          <p className="mt-1 text-xs text-ink-soft">
            {assignment
              ? "Opens a real florist magic link, read-only view-as (staff can't act as the florist through it)."
              : "No assignment on this order yet — nothing to view as a florist (e.g. the no-nearby-shop escalation scenario)."}
          </p>
          <Button
            type="button"
            variant="solid"
            disabled={!assignment || minting}
            onClick={() => void openFloristScreen()}
            className="mt-3"
          >
            {minting ? "Minting link…" : "Open florist screen (read-only view-as) ↗"}
          </Button>
          {floristReferencePath && (
            <p className="mt-1 text-xs text-ink-faint">Reference path: {floristReferencePath} (requires a florist session — not directly openable from staff).</p>
          )}
          {floristMsg && <p className="mt-2 text-xs text-ok">{floristMsg}</p>}
          {floristErr && <p className="mt-2 text-xs text-crit">{floristErr}</p>}
        </Card>
      </div>

      <Card style={{ marginTop: 16 }}>
        <p className="eyebrow">IDs (for QA / support handoff)</p>
        <pre className="mt-2 whitespace-pre-wrap text-xs text-ink-soft">{idBundle || "—"}</pre>
        <Button type="button" variant="ghost" onClick={() => void copyIds()} className="mt-2">
          {copied ? "Copied" : "Copy IDs"}
        </Button>
      </Card>
    </div>
  );
}
