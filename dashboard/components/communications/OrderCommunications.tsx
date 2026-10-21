"use client";

import { useState } from "react";
import { formatDateTime, formatRelative } from "@/components/orders/format";
import { AudienceBadge, ChannelIcon, StatusBadge, TestTag } from "./shared";
import type { Communication } from "./types";

/** Compact `.line-item`-style list of one order's communications (email,
 * push, or SMS, every audience) — content on click, distinct from the bottom
 * Timeline/event card which only carries state-change labels. Rendered
 * inside a `CollapseCard` on OrderDetailClient; that wrapper owns the
 * peek count + default-open-on-failure logic. */
export default function OrderCommunications({ communications }: { communications: Communication[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // Separate from expandedId — the rendered-email preview is heavier (an
  // iframe) than the rest of the expanded content, so it stays collapsed by
  // default even once a row is expanded and only one can be open at a time.
  const [htmlPreviewId, setHtmlPreviewId] = useState<string | null>(null);

  if (communications.length === 0) {
    return <p style={{ color: "var(--ink-faint)", fontSize: ".9rem" }}>No messages sent for this order yet.</p>;
  }

  return (
    <div>
      {communications.map((c) => {
        const expanded = expandedId === c.id;
        return (
          <div key={c.id}>
            <button
              type="button"
              onClick={() => setExpandedId(expanded ? null : c.id)}
              aria-expanded={expanded}
              className="line-item"
              style={rowButtonStyle}
            >
              <span className="thumb" style={thumbStyle}>
                <ChannelIcon channel={c.channel} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <AudienceBadge audience={c.audience} />
                  <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.to_address ?? "—"}
                  </span>
                  {c.test_mode && <TestTag toAddress={c.to_address} />}
                </div>
                <div style={{ color: "var(--ink-faint)", fontSize: ".78rem", marginTop: 2 }} title={formatDateTime(c.created_at)}>
                  {c.subject ?? c.kind} · {formatRelative(c.created_at)}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                <StatusBadge status={c.status} error={c.error} />
                <span
                  aria-hidden="true"
                  style={{
                    color: "var(--ink-faint)",
                    display: "inline-block",
                    transform: expanded ? "rotate(90deg)" : undefined,
                    transition: "transform .15s ease",
                  }}
                >
                  ›
                </span>
              </div>
            </button>
            {expanded && (
              <div style={expandStyle}>
                {c.subject && <div style={{ fontWeight: 700, marginBottom: 6 }}>{c.subject}</div>}
                <dl className="kv">
                  <dt>To</dt><dd>{c.to_address ?? "—"}</dd>
                  <dt>From</dt><dd>{c.actor ?? "system"}</dd>
                  <dt>Kind</dt><dd>{c.kind}</dd>
                  <dt>Provider</dt>
                  <dd>{c.provider}{c.provider_message_id ? ` · ${c.provider_message_id}` : ""}</dd>
                  {c.status === "failed" && (
                    <>
                      <dt>Error</dt>
                      <dd style={{ color: "var(--crit)" }}>{c.error ?? "—"}</dd>
                    </>
                  )}
                </dl>
                <div style={{ whiteSpace: "pre-wrap", fontSize: ".85rem", marginTop: 8, background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, padding: 10 }}>
                  {c.body ?? "No body recorded."}
                </div>
                {c.channel === "email" && c.html && (
                  <div style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      className="link-subtle"
                      style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit" }}
                      onClick={() => setHtmlPreviewId(htmlPreviewId === c.id ? null : c.id)}
                    >
                      {htmlPreviewId === c.id ? "Hide rendered email" : "View rendered email →"}
                    </button>
                    {htmlPreviewId === c.id && (
                      <iframe
                        title={`Rendered email — ${c.subject ?? c.id}`}
                        sandbox=""
                        srcDoc={c.html}
                        style={{ width: "100%", height: 500, marginTop: 6, border: "1px solid var(--line)", borderRadius: 8, background: "#fff" }}
                      />
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const rowButtonStyle: React.CSSProperties = {
  width: "100%",
  textAlign: "left",
  background: "none",
  border: "none",
  cursor: "pointer",
  font: "inherit",
  color: "inherit",
};

const thumbStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const expandStyle: React.CSSProperties = {
  marginLeft: 50,
  marginBottom: 9,
  background: "var(--surface-2)",
  borderRadius: 8,
  padding: 10,
  fontSize: ".82rem",
};
