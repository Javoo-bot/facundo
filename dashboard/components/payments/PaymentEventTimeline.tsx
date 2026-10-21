// Renders a payout's payment_events as a compact timeline. Plain (server-
// renderable) component — no client state.

const EVENT_LABEL: Record<string, string> = {
  issued: "Card issued",
  authorized: "Authorized",
  settled: "Settled (paid)",
  failed: "Payout failed",
  declined: "Transaction declined",
  held: "Held (pending review)",
  exposure_capped: "Exposure cap reached",
  insufficient_funds: "Insufficient funds",
  clawed_back: "Clawed back",
  card_closed: "Card closed",
  card_close_failed: "Card close failed",
  card_revealed: "Card revealed (florist)",
  card_revealed_staff: "Card revealed (staff)",
  card_limit_adjusted: "Card limit adjusted",
  dispute: "Dispute update",
};

function detail(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  const bits: string[] = [];
  if (p.last4) bits.push(`•••• ${p.last4}`);
  if (p.oldAmount != null && p.newAmount != null) bits.push(`€${p.oldAmount} → €${p.newAmount}`);
  if (p.amount != null) bits.push(`€${p.amount}`);
  if (p.disputeStatus) bits.push(String(p.disputeStatus));
  if (p.reason) bits.push(String(p.reason));
  if (p.error) bits.push(String(p.error).slice(0, 60));
  if (p.cap != null) bits.push(`cap €${p.cap}`);
  return bits.join(" · ");
}

export default function PaymentEventTimeline({ events }: { events: { type: string; payload: unknown; created_at: string }[] }) {
  if (!events.length) return <p style={{ color: "var(--ink-faint)", fontSize: ".85rem" }}>No events yet.</p>;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {events.map((e, i) => {
        const d = detail(e.payload);
        return (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, fontSize: ".82rem" }}>
            <span>
              {EVENT_LABEL[e.type] ?? e.type}
              {d && <span style={{ color: "var(--ink-faint)" }}> · {d}</span>}
            </span>
            <span style={{ color: "var(--ink-faint)", whiteSpace: "nowrap" }}>
              {new Date(e.created_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
            </span>
          </div>
        );
      })}
    </div>
  );
}
