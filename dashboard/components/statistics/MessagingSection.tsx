"use client";
import { StatTile, ChartCard, ChartEmpty } from "./ChartPrimitives";
import type { MessagingStats } from "@/lib/opsStats";

// All three florist-facing channels in one place, replacing the email-only
// section. The point of putting them side by side is a question you could not
// previously ask: "was this florist reachable AT ALL?" That became the
// operative question on 2026-08-06, when 364 florists whose stored email was
// not their own had that channel suppressed, leaving SMS and push carrying
// them (see supabase/migrations/2026-08-06-florist-networks.sql).

/** A cell that is genuinely unknowable for a channel, as opposed to zero.
 *  Rendering 0 where we cannot measure would read as "nobody opened it" when
 *  the truth is "nothing tells us" — the one thing a stats page must not do. */
const NA = "—";

interface Row {
  channel: string;
  sent: number;
  delivered: number | null;
  opened: number | null;
  clicked: number | null;
  /** Shown under the row when a number needs its provenance explained. */
  note?: string;
}

export default function MessagingSection({ data }: { data: MessagingStats }) {
  const rows: Row[] = [
    {
      channel: "Email",
      sent: data.email.sent,
      delivered: data.email.delivered,
      opened: data.email.opened,
      clicked: data.email.clicked,
    },
    {
      channel: "SMS",
      sent: data.sms.sent,
      delivered: data.sms.delivered,
      // No carrier-level read receipt exists.
      opened: null,
      clicked: data.sms.clicked,
      note: "SMS clicks are short-link hits; there is no carrier equivalent of an open.",
    },
    {
      channel: "Push",
      sent: data.push.sent,
      // Web push has no delivery receipt or open signal we collect.
      delivered: null,
      opened: null,
      clicked: null,
    },
  ];

  const totalSent = rows.reduce((n, r) => n + r.sent, 0);
  // Scale every bar to the largest SENT across channels, so the rows are
  // comparable to each other rather than each normalised to its own total.
  const max = Math.max(1, ...rows.map((r) => r.sent));
  const notes = rows.map((r) => r.note).filter(Boolean) as string[];

  return (
    <section style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        <StatTile label="Sent (all channels)" value={String(totalSent)} />
        <StatTile label="Email bounced" value={String(data.email.bounced)} />
        <StatTile label="Email complained" value={String(data.email.complained)} />
        <StatTile label="SMS failed" value={String(data.sms.failed)} />
      </div>

      <ChartCard title="Reach by channel">
        {totalSent === 0 ? (
          <ChartEmpty label="Nothing sent in this range." />
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "64px 1fr repeat(4, 68px)",
                gap: 8,
                fontSize: ".72rem",
                color: "var(--ink-faint)",
                textTransform: "uppercase",
                letterSpacing: ".04em",
              }}
            >
              <span />
              <span />
              <span style={{ textAlign: "right" }}>Sent</span>
              <span style={{ textAlign: "right" }}>Delivered</span>
              <span style={{ textAlign: "right" }}>Opened</span>
              <span style={{ textAlign: "right" }}>Clicked</span>
            </div>

            {rows.map((r) => (
              <div
                key={r.channel}
                style={{ display: "grid", gridTemplateColumns: "64px 1fr repeat(4, 68px)", alignItems: "center", gap: 8 }}
              >
                <span style={{ fontSize: ".8rem", color: "var(--ink-soft)" }}>{r.channel}</span>
                <div
                  style={{ background: "var(--line)", borderRadius: 4, overflow: "hidden", height: 12 }}
                  role="img"
                  aria-label={`${r.channel}: ${r.sent} sent, ${r.delivered ?? "unknown"} delivered`}
                >
                  <div style={{ width: `${(r.sent / max) * 100}%`, background: "var(--accent)", height: "100%" }} />
                </div>
                {([r.sent, r.delivered, r.opened, r.clicked] as (number | null)[]).map((value, i) => (
                  <span
                    key={i}
                    style={{
                      fontSize: ".8rem",
                      textAlign: "right",
                      color: value == null ? "var(--ink-faint)" : "var(--ink)",
                    }}
                    title={value == null ? `Not measurable for ${r.channel}` : undefined}
                  >
                    {value == null ? NA : value}
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
      </ChartCard>

      {notes.length > 0 && (
        <p style={{ margin: 0, fontSize: ".75rem", color: "var(--ink-faint)" }}>
          {notes.join(" ")}
        </p>
      )}
    </section>
  );
}
