"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { OrderApproval, OrderApprovalKind, ApprovalPreview } from "@/lib/types";
import { isEmailKind } from "@/lib/approvalKinds";
import Button from "@/components/ui/Button";
import SendOfferDialog from "@/components/orders/SendOfferDialog";
import { formatMoney } from "@/components/orders/format";

// Semi-mode (step) gate: a system transition the loop proposed, waiting for a human.
// Generalized across every kind — Approve fires the step; for emails you can Edit the
// draft before sending ("request changes"); Reject declines it (an offer → tries the
// next candidate). Mounted on the order page — the standalone CX desk that
// also rendered it was removed on 2026-08-10.

const HEADER: Record<OrderApprovalKind, { tag: string; ask: (name: string | null) => string }> = {
  offer: { tag: "offer", ask: (n) => `Offer this order to ${n ?? "the next florist"}?` },
  match: { tag: "match", ask: () => "Make these matched candidates live?" },
  reassign: { tag: "reassign", ask: () => "Hand this order to the next-ranked florist?" },
  escalate: { tag: "escalate", ask: () => "Escalate this order?" },
  writeback: { tag: "write-back", ask: () => "Write this status back to Shopify?" },
  client_assigned: { tag: "customer email", ask: () => "Send the customer their ‘florist assigned’ email?" },
  client_on_the_way: { tag: "customer email", ask: () => "Send the customer their ‘on the way’ email?" },
  client_delivered: { tag: "customer email", ask: () => "Send the customer their ‘delivered’ email?" },
  // Not a step in the loop — the order is already placed and stays placed. The
  // question is only whether to nudge the shop holding it.
  chase_photo: { tag: "chase", ask: (n) => `Ask ${n ?? "this florist"} for a photo?` },
};

function PreviewBody({ approval, floristNames }: { approval: OrderApproval; floristNames?: Record<string, string> }) {
  const p = approval.preview as ApprovalPreview | null;

  // Rendered customer email — sandboxed iframe (no scripts, no same-origin).
  if (p && p.type === "email") {
    return (
      <div style={{ display: "grid", gap: 6 }}>
        <div style={{ fontSize: ".78rem", color: "var(--ink-soft)" }}>
          To <b>{p.to ?? "—"}</b>{p.testMode ? " · test mode" : ""} · <b>{p.subject}</b>
        </div>
        <iframe
          title={`Rendered email — ${p.subject}`}
          sandbox=""
          srcDoc={p.html}
          style={{ width: "100%", height: 420, border: "1px solid var(--line)", borderRadius: 8, background: "#fff" }}
        />
      </div>
    );
  }

  // Match candidate list.
  if (p && p.type === "match") {
    return (
      <ol style={{ margin: 0, paddingLeft: 18, fontSize: ".82rem", display: "grid", gap: 2 }}>
        {p.candidates.map((c) => (
          <li key={c.floristId}>
            {floristNames?.[c.floristId] ?? c.floristName ?? c.floristId.slice(0, 8)}
            {c.distanceKm != null ? <span style={{ color: "var(--ink-soft)" }}> · {c.distanceKm.toFixed(1)} km</span> : null}
          </li>
        ))}
        {p.candidates.length === 0 && <li style={{ color: "var(--ink-soft)" }}>No candidates.</li>}
      </ol>
    );
  }

  // Shopify write-back diff. floristNumber/totalPayout are both optional and
  // frequently absent (no Florist ID assigned yet; non-delivery writebacks
  // never carry a payout) — omit each entirely rather than render a
  // null/undefined/"—" placeholder, so the preview only ever describes what
  // will actually be written to Shopify.
  if (p && p.type === "writeback") {
    const payoutAmount = p.totalPayout?.amount;
    const hasPayout = payoutAmount != null && Number.isFinite(payoutAmount);
    return (
      <div style={{ fontSize: ".82rem", color: "var(--ink-soft)" }}>
        Set Shopify order <b>#{p.shopifyOrderId}</b> → status <b>{p.state}</b>
        {p.florist ? <> · florist <b>{p.florist}</b></> : null}
        {p.floristNumber != null ? <> · Florist ID <b>{p.floristNumber}</b></> : null}
        {hasPayout ? <> · payout <b>{formatMoney(p.totalPayout!.amount, p.totalPayout!.currency)}</b></> : null}
      </div>
    );
  }

  // Escalate / reassign reason.
  if (p && p.type === "reason") {
    const reason = approval.kind === "escalate"
      ? p.reason.replace(/hand to CX to place manually\.?/i, "place manually from here.")
      : p.reason;
    return <div style={{ fontSize: ".82rem", color: "var(--ink-soft)" }}>{reason}</div>;
  }

  // Offer with no structured preview → the editable draft (its historic UI).
  if (approval.kind === "offer") {
    return (
      <div style={{ fontSize: ".82rem", color: "var(--ink-soft)", whiteSpace: "pre-wrap", maxHeight: 120, overflow: "auto" }}>
        <b>{approval.draft_subject || "New Facundo order"}</b>
        {"\n"}{approval.draft_body || "You have a new order — please review in your Facundo dashboard."}
      </div>
    );
  }
  return null;
}

export default function ApprovalPanel({
  approval,
  floristName,
  floristNames,
  orderName,
}: {
  approval: OrderApproval;
  floristName?: string | null;
  floristNames?: Record<string, string>;
  orderName?: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(approval.draft_subject ?? "");
  const [body, setBody] = useState(approval.draft_body ?? "");
  const [error, setError] = useState<string | null>(null);
  // Only an OFFER approval contacts a florist, so only that one routes
  // through the shared send-confirm surface; the client-notice kinds keep
  // their one-click approve.
  const [confirming, setConfirming] = useState(false);

  const editable = isEmailKind(approval.kind);
  const head = HEADER[approval.kind] ?? { tag: approval.kind, ask: () => "Approve this step?" };
  const rejectLabel = approval.kind === "offer" ? "Skip florist" : "Reject";
  const isOfferSend = approval.kind === "offer" && !!approval.assignment_id;

  const act = async (action: "approve" | "reject", withEdits = false, channels?: string[], draft?: { subject: string; body: string } | null) => {
    setBusy(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = { approvalId: approval.id, action };
      if (action === "approve" && withEdits) { payload.subject = subject; payload.body = body; }
      if (draft) { payload.subject = draft.subject; payload.body = draft.body; }
      if (channels?.length) payload.channels = channels;
      const res = await fetch("/api/orders/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error || `Failed (${res.status}).`);
      } else {
        setConfirming(false);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ocard" style={{ display: "grid", gap: 10, borderColor: "var(--brand, #b1006b)", borderWidth: 1, borderStyle: "solid" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div>
          <div className="mini-h" style={{ color: "var(--brand, #b1006b)" }}>
            Approval needed · {head.tag}{orderName ? ` · ${orderName}` : ""}
          </div>
          <div style={{ fontWeight: 600 }}>{head.ask(floristName ?? null)}</div>
        </div>
        <span className="badge badge-neutral">semi-automatic</span>
      </div>

      {editing && editable ? (
        <div style={{ display: "grid", gap: 8 }}>
          <label className="mini-h">Subject</label>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} className="w-full rounded-md border border-line-strong px-3 py-1.5 text-sm" />
          <label className="mini-h">Message</label>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} className="w-full rounded-md border border-line-strong px-3 py-2 text-sm" style={{ fontFamily: "inherit" }} />
          <div style={{ fontSize: ".72rem", color: "var(--ink-soft)" }}>The email is re-rendered from your edits when it sends.</div>
        </div>
      ) : (
        <PreviewBody approval={approval} floristNames={floristNames} />
      )}

      {error && <div style={{ color: "var(--crit)", fontSize: ".8rem" }}>{error}</div>}

      {isOfferSend && confirming && approval.assignment_id && (
        <SendOfferDialog
          assignmentId={approval.assignment_id}
          kind="approve"
          floristName={floristName ?? null}
          draft={{ subject, body }}
          busy={busy}
          onCancel={() => setConfirming(false)}
          onConfirm={(o) => act("approve", false, o.channels, o.draft)}
        />
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {editing && editable ? (
          <>
            <Button variant="solid" disabled={busy} onClick={() => act("approve", true)} style={{ justifyContent: "center" }}>Send with changes</Button>
            <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)} style={{ justifyContent: "center" }}>Cancel</Button>
          </>
        ) : (
          <>
            <Button
              variant="solid"
              disabled={busy}
              onClick={() => (isOfferSend ? setConfirming((v) => !v) : act("approve"))}
              style={{ justifyContent: "center" }}
            >
              {isOfferSend && confirming ? "Close" : approval.kind === "offer" || approval.kind.startsWith("client_") ? "Approve & send" : "Approve"}
            </Button>
            {editable && <Button variant="ghost" disabled={busy} onClick={() => setEditing(true)} style={{ justifyContent: "center" }}>Edit mail</Button>}
            <Button variant="warn" disabled={busy} onClick={() => act("reject")} style={{ justifyContent: "center" }}>{rejectLabel}</Button>
          </>
        )}
      </div>
    </div>
  );
}
