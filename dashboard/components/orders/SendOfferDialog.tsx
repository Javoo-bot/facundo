"use client";

import { useCallback, useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import { OFFER_CHANNELS, type OfferChannel } from "@/lib/reachout";

// ONE confirm surface for every button that sends an offer to a florist.
//
// Before this existed, five buttons sent an offer and no two behaved the same:
// Send and "Advance → send" fired a real email in one click with no preview at
// all, Re-send had a preview but no channel choice, "Send again" had channel
// choice but no preview, and the offer-approval Send had an editable draft but
// neither. Two of those reach a shop that has never heard of us.
//
// Everything below is the confirm step in front of the existing senders. It
// changes nothing about what actually goes out.

/** Response shape of GET /api/orders/reachout/preview — see that route for the
 *  authoritative comments; kept in sync by hand (no shared schema). */
export type PreviewResponse = {
  ok: boolean;
  subject: string;
  html: string;
  bodyText: string;
  locale: string;
  variant: "full" | "short";
  test_mode: boolean;
  to: string | null;
  intended: string | null;
  email_leg: "send" | "skipped";
  email_leg_reason: string | null;
  expires_at_preview: string | null;
  reply_window: string;
  unsubscribe_url_is_placeholder: boolean;
  channels: { channel: OfferChannel; available: boolean; reason: string | null }[];
  resendable: boolean;
  block_reason: string | null;
  prior_status: string;
  florist: { id: string; name: string | null };
};

const CHANNEL_LABEL: Record<OfferChannel, string> = { email: "Email", sms: "SMS", push: "Push" };

/** Why a channel can't (or didn't) carry the offer. Mirrors the reason strings
 *  lib/offerChannels.ts returns and lib/reachoutRenotify.ts reports, so CX
 *  reads "no phone number on file" rather than an opaque failure. */
export const CHANNEL_REASON_COPY: Record<string, string> = {
  "disabled-by-settings": "turned off in Settings",
  "channel-not-selected": "not selected",
  "cooling-down": "just sent — try again shortly",
  "no-test-email": "test mode is on but no test email is configured",
  "florist-no-email": "no email address on file",
  "florist-email-is-network": "the address on file is the network's head office, not this shop",
  "florist-email-shared": "the address on file belongs to several shops, so it can't reach this one",
  "florist-email-bounced": "the address on file bounced",
  "florist-opted-out": "florist opted out of offer emails",
  "florist-snoozed": "florist has offer emails snoozed",
  "florist-no-sms-phone": "no phone number on file",
  "florist-sms-undeliverable": "the carrier reported this number can’t receive texts",
  "florist-sms-opted-out": "florist opted out of texts",
  "florist-sms-snoozed": "florist has texts snoozed",
  "no-test-phone": "test mode is on but no test phone is configured",
  "no-push-subscription": "florist hasn't installed the app",
  "push-failed": "push delivery failed",
};

/** Why the send itself is refused right now — the enum
 *  lib/reachout.ts::resendBlockReason returns, worded to match the POST's 409s
 *  so the reason shown here can never disagree with the one returned. */
const BLOCK_REASON_COPY: Record<string, string> = {
  "not-sent-yet": "This offer hasn't been sent yet — use Send instead.",
  "already-accepted": "That florist already accepted this order.",
  "assignment-closed": "This assignment is closed — add or reassign a florist instead.",
  "still-live": "That offer is still live — decline it first if you need to re-send now.",
  "order-not-open": "This order is no longer open for outreach — nothing to re-offer.",
  "order-cancelled": "This order is cancelled.",
  "order-deleted": "This order was deleted.",
};

export type ChannelResult = { channel: OfferChannel; status: "sent" | "skipped" | "failed"; reason?: string };

/** What kind of send this is. Drives the confirm label, which extras show, and
 *  whether the preview's `resendable` gate applies. */
export type SendKind = "send" | "resend" | "renotify" | "approve";

export interface SendOfferDialogProps {
  assignmentId: string;
  kind: SendKind;
  /** Shown in the header so CX can see who this is going to. */
  floristName: string | null;
  /** Editable draft, when the caller has one (offer approvals). Absent means
   *  the copy isn't editable here and no "Edit text" affordance is offered. */
  draft?: { subject: string; body: string } | null;
  busy: boolean;
  /** Per-channel outcome from the last attempt, when the caller has one. */
  results?: ChannelResult[] | null;
  onCancel: () => void;
  onConfirm: (opts: {
    channels: OfferChannel[];
    reason: string;
    resetWindow: boolean;
    draft: { subject: string; body: string } | null;
  }) => void;
}

const CONFIRM_LABEL: Record<SendKind, string> = {
  send: "Send offer",
  resend: "Confirm re-send",
  renotify: "Send again",
  approve: "Approve and send",
};

export default function SendOfferDialog({
  assignmentId, kind, floristName, draft = null, busy, results = null, onCancel, onConfirm,
}: SendOfferDialogProps) {
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<OfferChannel> | null>(null);
  const [reason, setReason] = useState("");
  const [resetWindow, setResetWindow] = useState(false);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(draft?.subject ?? "");
  const [body, setBody] = useState(draft?.body ?? "");

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError(null);
    fetch(`/api/orders/reachout/preview?assignmentId=${encodeURIComponent(assignmentId)}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) { setError(json.error ?? "Couldn't load the preview."); return; }
        setPreview(json as PreviewResponse);
        // Default to every channel that can actually fire. A channel we already
        // know is unreachable starts unticked rather than silently failing.
        setSelected(new Set((json.channels ?? []).filter((c: { available: boolean }) => c.available).map((c: { channel: OfferChannel }) => c.channel)));
      })
      .catch(() => { if (!cancelled) setError("Couldn't load the preview."); });
    return () => { cancelled = true; };
  }, [assignmentId]);

  const toggle = useCallback((c: OfferChannel) => {
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  }, []);

  const box: React.CSSProperties = {
    marginTop: 10, border: "1px solid var(--line)", borderRadius: 8, padding: 12,
    background: "var(--surface-2)", display: "grid", gap: 10,
  };

  if (error) {
    return (
      <div style={box}>
        <p style={{ color: "var(--crit)", fontSize: ".85rem", margin: 0 }}>{error}</p>
        <div><Button variant="ghost" onClick={onCancel}>Close</Button></div>
      </div>
    );
  }
  if (!preview || !selected) {
    return <div style={box}><p style={{ color: "var(--ink-faint)", fontSize: ".85rem", margin: 0 }}>Loading preview…</p></div>;
  }

  // The resendable gate only applies to a re-send; the other kinds have their
  // own server-side CAS and would be wrongly blocked by it (a candidate/queued
  // row is deliberately "not-sent-yet" for resend purposes).
  const blocked = kind === "resend" && !preview.resendable;

  return (
    <div style={box}>
      <div style={{ fontSize: ".85rem", display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <b>{CONFIRM_LABEL[kind]}</b>
        <span style={{ color: "var(--ink-soft)" }}>to {floristName ?? preview.florist.name ?? "this florist"}</span>
        <span className="badge badge-neutral">{preview.locale}</span>
      </div>

      {/* test_mode is currently OFF in production — make LIVE unmistakable at
          the point of action, not just in the card header above. */}
      {preview.test_mode ? (
        <div style={{ fontSize: ".8rem", fontWeight: 600, color: "var(--warn)" }}>
          TEST MODE — goes to {preview.to ?? "the test inbox"} (test inbox), not the florist.
        </div>
      ) : (
        <div style={{
          fontSize: ".82rem", fontWeight: 700, color: "var(--crit)",
          background: "color-mix(in srgb, var(--crit) 10%, transparent)",
          border: "1px solid var(--crit)", borderRadius: 6, padding: "6px 10px",
        }}>
          LIVE — this really contacts {preview.to ?? "the florist"}
        </div>
      )}

      {/* Channels, with the reason a leg can't fire shown BEFORE sending
          rather than in the results afterwards. */}
      <div style={{ display: "grid", gap: 5 }}>
        <div className="mini-h">Channels</div>
        {OFFER_CHANNELS.map((c) => {
          const info = preview.channels?.find((x) => x.channel === c);
          const available = info?.available ?? true;
          return (
            <label
              key={c}
              style={{
                display: "flex", gap: 7, alignItems: "baseline", fontSize: ".85rem",
                color: available ? "var(--ink)" : "var(--ink-faint)",
              }}
            >
              <input type="checkbox" checked={selected.has(c)} disabled={!available || busy} onChange={() => toggle(c)} />
              <span>{CHANNEL_LABEL[c]}</span>
              {!available && info?.reason && (
                <span style={{ fontSize: ".78rem" }}>· {CHANNEL_REASON_COPY[info.reason] ?? info.reason}</span>
              )}
              {available && c === "email" && preview.to && (
                <span style={{ fontSize: ".78rem", color: "var(--ink-faint)" }}>· to {preview.to}</span>
              )}
            </label>
          );
        })}
      </div>

      {kind === "renotify" && (
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: ".85rem" }}>
          <input type="checkbox" checked={resetWindow} disabled={busy} onChange={(e) => setResetWindow(e.target.checked)} />
          Give them a fresh window
        </label>
      )}

      <div style={{ fontSize: ".8rem", color: "var(--ink-soft)" }}>Reply window: {preview.reply_window}</div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <div className="mini-h">Preview</div>
        {draft && (
          <button type="button" className="link" style={{ fontSize: ".8rem" }} onClick={() => setEditing((v) => !v)}>
            {editing ? "Back to preview" : "Edit text"}
          </button>
        )}
      </div>

      {editing && draft ? (
        <div style={{ display: "grid", gap: 6 }}>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject"
            style={{ padding: "6px 8px", fontSize: ".85rem", border: "1px solid var(--line)", borderRadius: 6 }}
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
            placeholder="Body"
            style={{ padding: "6px 8px", fontSize: ".85rem", border: "1px solid var(--line)", borderRadius: 6, fontFamily: "inherit" }}
          />
          <div style={{ fontSize: ".72rem", color: "var(--ink-faint)" }}>
            Your edits are sent as-is; the rest of the email chrome is unchanged.
          </div>
        </div>
      ) : (
        <>
          <div style={{ fontSize: ".82rem", color: "var(--ink-soft)" }}>{preview.subject}</div>
          <iframe
            title={`Rendered email — ${preview.subject}`}
            sandbox=""
            srcDoc={preview.html}
            style={{ width: "100%", height: 420, border: "1px solid var(--line)", borderRadius: 8, background: "#fff" }}
          />
        </>
      )}

      {preview.unsubscribe_url_is_placeholder && (
        <div style={{ fontSize: ".72rem", color: "var(--ink-faint)" }}>
          The unsubscribe link shown is a placeholder — a real one-time token is minted when you send.
        </div>
      )}

      {blocked && (
        <div style={{ fontSize: ".82rem", color: "var(--crit)" }}>
          {BLOCK_REASON_COPY[preview.block_reason ?? ""] ?? "This can no longer be sent — reload and try again."}
        </div>
      )}

      {kind === "resend" && (
        <div style={{ display: "grid", gap: 6 }}>
          <label style={{ fontSize: ".72rem", color: "var(--ink-faint)" }}>Reason for re-sending (optional, kept for audit)</label>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, 500))}
            placeholder="e.g. locale corrected to es"
            style={{ padding: "6px 8px", fontSize: ".85rem", border: "1px solid var(--line)", borderRadius: 6 }}
          />
        </div>
      )}

      {results && (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: ".82rem" }}>
          {results.map((r) => (
            <li key={r.channel} style={{ color: r.status === "sent" ? "var(--ok, var(--ink))" : r.status === "failed" ? "var(--crit)" : "var(--ink-faint)" }}>
              {CHANNEL_LABEL[r.channel]}: {r.status}
              {r.reason ? ` — ${CHANNEL_REASON_COPY[r.reason] ?? r.reason}` : ""}
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <Button
          variant="solid"
          disabled={busy || blocked || selected.size === 0}
          onClick={() => onConfirm({
            channels: [...selected],
            reason,
            resetWindow,
            draft: draft && editing ? { subject, body } : null,
          })}
        >
          {busy ? "Sending…" : CONFIRM_LABEL[kind]}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
