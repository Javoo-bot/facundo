"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { OrderAssignment, Florist } from "@/lib/types";
import type { OrderStatus } from "@/lib/orderStatus";
import Badge, { assignmentStatusBadge, sourceBadge } from "@/components/ui/Badge";
import SlaDot from "@/components/ui/SlaDot";
import Button from "@/components/ui/Button";
import ActionMenu, { type ActionGroup } from "@/components/ui/ActionMenu";
import { nextSendableCandidate, isResendable, isRenotifiable } from "@/lib/reachout";
import CandidateProgress from "./CandidateProgress";
import type { CandidateEngagement } from "@/lib/candidateEngagement";
import SendOfferDialog, { type ChannelResult, type SendKind } from "@/components/orders/SendOfferDialog";
import { OFFER_CHANNELS, type OfferChannel } from "@/lib/reachout";
import { formatMoney } from "@/components/orders/format";
import { haversineKm, formatKm } from "@/lib/geo";
import { reachoutStats } from "@/components/orders/orderDerive";

export default function ReachoutPanel({
  assignments, florists, engagement, testMode, workflowMode, currency, orderStatus, orderDeletedAt,
  deliveryLat, deliveryLng, defaultOpen = true,
}: {
  assignments: OrderAssignment[]; florists: Florist[];
  /** Per-assignment engagement trail, resolved server-side (credentials never
   *  reach the client — see lib/candidateEngagement.ts). Keyed by assignment id. */
  engagement?: Record<string, CandidateEngagement>;
  testMode: boolean; workflowMode: string; currency: string | null;
  /** Order-level gate for isResendable — a DIFFERENT florist mustn't already hold/have fulfilled the order. */
  orderStatus: OrderStatus;
  orderDeletedAt: string | null;
  /** Geocoded delivery point, for the per-candidate distance. Either may be
   *  null (un-geocoded address, or a florist without coords) — the row then
   *  simply omits the distance rather than showing a bogus one. */
  deliveryLat: number | null;
  deliveryLng: number | null;
  /** Initial open/closed state of the collapsible panel — the caller decides
   *  based on order status (reach-outs are core work before acceptance,
   *  history after — see OrderDetailClient). Uncontrolled after mount, same
   *  as every other `<details>` card on this page. */
  defaultOpen?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  // ONE confirm surface for every send on this panel. `kind` decides which
  // endpoint the confirm hits and which extras the dialog shows; the dialog
  // itself loads the preview and the per-channel availability.
  const [dialog, setDialog] = useState<{ assignmentId: string; kind: SendKind } | null>(null);
  const [results, setResults] = useState<ChannelResult[] | null>(null);
  // BULK SEND. Ticked candidates that haven't been offered yet; the batch goes
  // out without a rendered preview (see app/api/orders/reachout/bulk).
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkChannels, setBulkChannels] = useState<Set<OfferChannel>>(new Set(OFFER_CHANNELS));
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ sent: number; failed: number } | null>(null);
  const byId = new Map(florists.map((f) => [f.id, f]));
  const next = nextSendableCandidate(assignments);

  async function act(assignmentId: string, action: string, extra?: object): Promise<boolean> {
    setBusy(assignmentId + action);
    try {
      const res = await fetch("/api/orders/reachout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assignmentId, action, ...extra }) });
      const j = await res.json().catch(() => ({}));
      // A 409 carrying per-channel results means every leg was skipped or
      // failed — show WHY per channel rather than one generic error.
      if (Array.isArray(j.results)) setResults(j.results as ChannelResult[]);
      if (!res.ok) { if (!Array.isArray(j.results)) alert(j.error ?? "Failed"); return false; }
      router.refresh();
      return true;
    } finally { setBusy(null); }
  }

  /** Open the confirm surface for one assignment. Nothing is sent until the
   *  dialog's own Confirm — including for Send and Advance, which used to fire
   *  a real email on this click. Opening is idempotent rather than a toggle:
   *  these are reached from a menu that has already closed itself, so a second
   *  pick must not silently dismiss the dialog it appears to open. Closing is
   *  the dialog's own Cancel. */
  function openDialog(assignmentId: string, kind: SendKind) {
    setResults(null);
    setDialog({ assignmentId, kind });
  }

  async function confirmSend(
    assignmentId: string,
    kind: SendKind,
    opts: { channels: string[]; reason: string; resetWindow: boolean },
  ) {
    const reason = opts.reason.trim();
    const action = kind === "renotify" ? "renotify" : kind === "resend" ? "resend" : "send";
    const extra: Record<string, unknown> = { channels: opts.channels };
    if (kind === "renotify") extra.resetWindow = opts.resetWindow;
    if (kind === "resend" && reason) extra.reason = reason;
    const ok = await act(assignmentId, action, extra);
    if (ok) setDialog(null);
  }

  /** Candidates nobody has offered this order to yet — the only rows a bulk
   *  send can act on. Everything else already has an offer out or is closed. */
  const unsent = assignments.filter((a) => a.status === "candidate" || a.status === "queued");
  const allPicked = unsent.length > 0 && unsent.every((a) => picked.has(a.id));

  function togglePick(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function sendBulk() {
    setBusy("bulk");
    setBulkResult(null);
    try {
      const res = await fetch("/api/orders/reachout/bulk", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignmentIds: [...picked], channels: [...bulkChannels] }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { alert(j.error ?? "Bulk send failed"); return; }
      setBulkResult({ sent: j.sent ?? 0, failed: j.failed ?? 0 });
      setPicked(new Set());
      setBulkOpen(false);
      router.refresh();
    } finally { setBusy(null); }
  }

  // Sent/opened/clicked/logged-in/declined counts across every candidate —
  // the "how is the reach-out going" glance the per-row engagement trail
  // doesn't answer on its own. See orderDerive.ts::reachoutStats.
  const stats = reachoutStats(assignments, engagement);

  return (
    // A collapsible card (same `card-collapse` shell as the other reference
    // cards on this page) rather than a plain card: once a florist has
    // accepted, this whole trail becomes history — see `defaultOpen`.
    <details className="card card-collapse" open={defaultOpen}>
      <summary>
        Reach-outs
        <span className="peek">
          · {stats.sent} sent · {stats.opened} opened{stats.declined > 0 ? ` · ${stats.declined} declined` : ""}
        </span>
        <span className="chev" aria-hidden="true">›</span>
      </summary>
      <div className="collapse-body">
        <div className="mini-h" style={{ marginBottom: 10, display: "flex", justifyContent: "space-between" }}>
          <span>Reach-out · per-candidate state</span>
          <span>{testMode ? "TEST MODE" : "LIVE"} · {workflowMode}</span>
        </div>

        {/* Stats bar — the aggregate funnel across every candidate this
            order has reached out to. */}
        {assignments.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
            <span className="badge badge-neutral">Sent {stats.sent}</span>
            <span className="badge badge-neutral">Opened {stats.opened}</span>
            <span className="badge badge-neutral">Clicked {stats.clicked}</span>
            <span className="badge badge-neutral">Logged in {stats.signedIn}</span>
            <span className="badge badge-neutral">Declined {stats.declined}</span>
          </div>
        )}

        {assignments.length === 0 && <p style={{ color: "var(--ink-faint)", fontSize: ".9rem" }}>No candidates yet.</p>}

        {/* Bounded + scrollable so a long candidate list (plus the bulk-send
            bar, which can itself expand when opened) doesn't dominate the
            order page — only the stats bar above and the bottom actions below
            stay outside it, always visible. */}
        <div style={{ maxHeight: 320, overflowY: "auto" }}>
          {/* BULK SEND BAR. Only appears when there is somebody left to ask. */}
          {unsent.length > 0 && (
            <div style={{ display: "grid", gap: 8, marginBottom: 10, paddingBottom: 10, borderBottom: "1px solid var(--line)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: ".85rem", flexWrap: "wrap" }}>
                <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={allPicked}
                    onChange={() => setPicked(allPicked ? new Set() : new Set(unsent.map((a) => a.id)))}
                  />
                  Select all {unsent.length} unsent
                </label>
                {picked.size > 0 && (
                  <Button variant="solid" disabled={busy !== null} onClick={() => setBulkOpen((v) => !v)}>
                    {bulkOpen ? "Close" : `Send to ${picked.size}`}
                  </Button>
                )}
                {bulkResult && (
                  <span style={{ color: "var(--ink-soft)" }}>
                    {bulkResult.sent} sent{bulkResult.failed ? ` · ${bulkResult.failed} skipped` : ""}
                  </span>
                )}
              </div>

              {bulkOpen && picked.size > 0 && (
                <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 12, background: "var(--surface-2)", display: "grid", gap: 10 }}>
                  {/* No rendered email here on purpose — the whole point of a batch
                      is not previewing the same message N times. The count and the
                      LIVE warning are the safety, and they are enough. */}
                  <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                    {OFFER_CHANNELS.map((c) => (
                      <label key={c} style={{ display: "inline-flex", gap: 5, alignItems: "center", fontSize: ".85rem" }}>
                        <input
                          type="checkbox"
                          checked={bulkChannels.has(c)}
                          onChange={() => setBulkChannels((prev) => {
                            const next = new Set(prev);
                            if (next.has(c)) next.delete(c); else next.add(c);
                            return next;
                          })}
                        />
                        {c === "email" ? "Email" : c === "sms" ? "SMS" : "Push"}
                      </label>
                    ))}
                  </div>
                  <div style={{
                    fontSize: ".82rem", fontWeight: 700,
                    color: testMode ? "var(--warn)" : "var(--crit)",
                    background: testMode ? undefined : "color-mix(in srgb, var(--crit) 10%, transparent)",
                    border: testMode ? undefined : "1px solid var(--crit)",
                    borderRadius: 6, padding: testMode ? 0 : "6px 10px",
                  }}>
                    {testMode
                      ? `TEST MODE — ${picked.size} offers go to the test inbox, not the florists.`
                      : `LIVE — this really contacts ${picked.size} ${picked.size === 1 ? "florist" : "florists"}.`}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button variant="solid" disabled={busy !== null || bulkChannels.size === 0} onClick={sendBulk}>
                      {busy === "bulk" ? "Sending…" : `Send to ${picked.size}`}
                    </Button>
                    <Button variant="ghost" disabled={busy !== null} onClick={() => setBulkOpen(false)}>Cancel</Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {assignments.map((a) => {
            const f = byId.get(a.florist_id);
            const resendable = isResendable({ status: a.status, offer_expires_at: a.offer_expires_at, withdrawn_at: a.withdrawn_at ?? null }, orderStatus, orderDeletedAt);
            // The exact complement of `resendable` for sent/opened: a LIVE offer can
            // be re-delivered, a dead or lapsed one is re-sent. `lastSentAt` is null
            // here because the client doesn't hold the communications log — the
            // cooldown is enforced server-side (429), and this gate is UX-only,
            // matching how `resendable` is used above.
            const renotifiable = isRenotifiable({ status: a.status, offer_expires_at: a.offer_expires_at, withdrawn_at: a.withdrawn_at ?? null }, orderStatus, orderDeletedAt, null);
            const openKind = dialog?.assignmentId === a.id ? dialog.kind : null;
            // How far this candidate is from where the order has to land — the
            // number CX weighs a manual send on. Null-guarded end to end: a florist
            // or an order without coords yields null, never NaN.
            const distance = formatKm(haversineKm(f?.lat, f?.lng, deliveryLat, deliveryLng));
            // Every legal move for this candidate, grouped, behind one trigger —
            // the row used to carry up to five buttons side by side. The
            // *conditions* are unchanged; only where they're rendered moved.
            const groups: ActionGroup[] = [
              {
                key: "offer",
                heading: "Offer",
                items: [
                  ...((a.status === "candidate" || a.status === "queued")
                    ? [{ key: "send", label: "Send offer…", onSelect: () => openDialog(a.id, "send") }]
                    : []),
                  ...(resendable
                    ? [{ key: "resend", label: "Re-send…", title: "The offer is dead or lapsed — send a fresh one.", onSelect: () => openDialog(a.id, "resend") }]
                    : []),
                  ...(renotifiable
                    ? [{ key: "renotify", label: "Send again…", title: "The offer is still live — re-deliver the same one.", onSelect: () => openDialog(a.id, "renotify") }]
                    : []),
                ],
              },
              {
                key: "resolve",
                heading: "Record outcome",
                items: [
                  ...((a.status === "sent" || a.status === "opened")
                    ? [{ key: "accept", label: "Mark accepted", onSelect: () => void act(a.id, "accept") }]
                    : []),
                  ...((a.status !== "accepted" && a.status !== "declined")
                    ? [{ key: "decline", label: "Decline", tone: "crit" as const, title: "Record that this florist said no.", onSelect: () => void act(a.id, "decline", { reason: "manual" }) }]
                    : []),
                ],
              },
              {
                // A lapsed offer is no longer self-closing — lib/lateAccept.ts lets
                // this florist still accept it while the order is unclaimed.
                // Withdraw is how CX says "not this one" without declining on the
                // florist's behalf. Pointless once they've accepted or the offer has
                // already been withdrawn.
                key: "table",
                heading: "Take off the table",
                tone: "warn",
                items: (!a.withdrawn_at && a.status !== "accepted" && a.status !== "delivered")
                  ? [{ key: "withdraw", label: "Withdraw", tone: "warn" as const, title: "This florist can no longer accept — without recording a decline.", onSelect: () => void act(a.id, "withdraw") }]
                  : [],
              },
            ];
            return (
              <div key={a.id} style={{ borderBottom: "1px solid var(--line)", padding: "10px 0" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, fontSize: ".9rem" }}>
                  <span>
                    {(a.status === "candidate" || a.status === "queued") && (
                      <input
                        type="checkbox"
                        checked={picked.has(a.id)}
                        disabled={busy !== null}
                        onChange={() => togglePick(a.id)}
                        style={{ marginRight: 6 }}
                        aria-label={`Select ${f?.name ?? "candidate"} for bulk send`}
                      />
                    )}
                    <b style={{ fontFamily: "var(--mono)", color: "var(--accent)" }}>{a.rank ?? "—"}</b>{" "}
                    <Link href={`/florists/${a.florist_id}`} className="link" title="View florist">{f?.name ?? a.florist_id.slice(0, 8)}</Link> <Badge info={sourceBadge(a.florist_source)} />
                    {distance ? <span style={{ color: "var(--ink-soft)" }} title="Straight-line distance from this florist to the delivery address"> · {distance}</span> : null}
                    {a.sla_deadline_at ? <> · <SlaDot deadlineIso={a.sla_deadline_at} label={`SLA ${new Date(a.sla_deadline_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`} /></> : null}
                    {a.status === "declined" && a.decline_detail ? <span style={{ color: "var(--crit)" }}> · {a.decline_reason} “{a.decline_detail}”</span> : null}
                  </span>
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ color: "var(--ink-faint)", fontSize: ".82rem" }} title={a.payout_percent != null ? `${a.payout_percent}% of items + delivery` : "Manually set"}>
                      {formatMoney(a.payout_price, currency)}
                    </span>
                    <Badge info={assignmentStatusBadge(a.status)} />
                    {a.withdrawn_at && (
                      <span
                        style={{ color: "var(--ink-faint)", fontSize: ".82rem" }}
                        title={`Withdrawn ${new Date(a.withdrawn_at).toLocaleString()} — this florist can no longer accept.`}
                      >
                        withdrawn
                      </span>
                    )}
                    <ActionMenu label="Actions" groups={groups} busy={busy !== null} align="right" />
                  </span>
                </div>
                <CandidateProgress engagement={engagement?.[a.id]} />
                {openKind && (
                  <SendOfferDialog
                    assignmentId={a.id}
                    kind={openKind}
                    floristName={f?.name ?? null}
                    busy={busy !== null}
                    results={results}
                    onCancel={() => { setDialog(null); setResults(null); }}
                    onConfirm={(o) => confirmSend(a.id, openKind, o)}
                  />
                )}
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          {next && <Button variant="solid" disabled={busy !== null} onClick={() => openDialog(next.id, "send")}>Advance → send #{next.rank}</Button>}
          {assignments[0] && <Button variant="warn" disabled={busy !== null} onClick={() => act(assignments[0].id, "escalate")}>Escalate</Button>}
        </div>
      </div>
    </details>
  );
}
