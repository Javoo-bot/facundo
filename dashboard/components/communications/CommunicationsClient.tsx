"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
import EmptyState from "@/components/EmptyState";
import ErrorState from "@/components/ErrorState";
import StatTile from "@/components/StatTile";
import FilterPopover from "@/components/orders/FilterPopover";
import { formatDateTime, formatRelative } from "@/components/orders/format";
import { IconAlertTriangle, IconMail } from "@/components/icons";
import { createBrowserClient } from "@/lib/supabase";
import { AudienceBadge, ChannelLabel, StatusBadge, TestTag } from "./shared";
import type { CommAudience, CommChannel, CommStatus, CommunicationRow } from "./types";

const COLS = 8;
// "Reasonable page size (e.g. 200) with a load more" per the design doc —
// the server page fetches the first page; the browser client (RLS-scoped,
// same idiom as components/shell/GlobalSearch.tsx) fetches subsequent pages
// on demand rather than adding a new API route.
const PAGE_SIZE = 200;

// The Audience filter groups cx+staff into one "CX · Staff" checkbox — they
// share a badge color (badge-bloom) in the table too, so the filter mirrors
// the same grouping the table already shows.
type AudienceKey = "florist" | "client" | "cx_staff";
const AUDIENCE_OPTIONS: { key: AudienceKey; label: string }[] = [
  { key: "florist", label: "Florist" },
  { key: "client", label: "Client" },
  { key: "cx_staff", label: "CX · Staff" },
];
function matchesAudience(audience: CommAudience, keys: Set<AudienceKey>): boolean {
  if (keys.size === 0) return true;
  if (keys.has("florist") && audience === "florist") return true;
  if (keys.has("client") && audience === "client") return true;
  if (keys.has("cx_staff") && (audience === "cx" || audience === "staff")) return true;
  return false;
}

const CHANNEL_OPTIONS: { key: CommChannel; label: string }[] = [
  { key: "email", label: "Email" },
  { key: "push", label: "Push" },
  { key: "sms", label: "SMS" },
];
const STATUS_OPTIONS: { key: CommStatus; label: string }[] = [
  { key: "sent", label: "Sent" },
  { key: "failed", label: "Failed" },
  { key: "skipped", label: "Skipped" },
  { key: "received", label: "Replies" },
];

function SkeletonRows({ rows = 8 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i}>
          <td colSpan={COLS}>
            <div className="skeleton-row">
              <span className="skeleton" style={{ width: 60, height: 14 }} />
              <span className="skeleton" style={{ width: 60, height: 14 }} />
              <span className="skeleton" style={{ width: 70, height: 14 }} />
              <span className="skeleton" style={{ width: 130, height: 14 }} />
              <span className="skeleton" style={{ width: 70, height: 14 }} />
              <span className="skeleton" style={{ width: 160, height: 14 }} />
              <span className="skeleton" style={{ width: 60, height: 14 }} />
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export default function CommunicationsClient({
  initialRows,
  error,
}: {
  initialRows: CommunicationRow[];
  error: string | null;
}) {
  // One-frame skeleton on mount — matches PaymentsLedger/OrdersClient.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  const supabase = useMemo(() => createBrowserClient(), []);
  const [rows, setRows] = useState(initialRows);
  const [hasMore, setHasMore] = useState(initialRows.length >= PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const [channelFilter, setChannelFilter] = useState<Set<CommChannel>>(new Set());
  const [audienceFilter, setAudienceFilter] = useState<Set<AudienceKey>>(new Set());
  const [statusFilter, setStatusFilter] = useState<Set<CommStatus>>(new Set());
  const [testOnly, setTestOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  async function loadMore() {
    const oldest = rows[rows.length - 1];
    if (!oldest || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const { data, error: fetchErr } = await supabase
        .from("communications")
        .select("*, orders(order_name)")
        .lt("created_at", oldest.created_at)
        .order("created_at", { ascending: false })
        .limit(PAGE_SIZE);
      if (fetchErr) {
        setLoadMoreError(fetchErr.message);
        return;
      }
      const next = (data ?? []) as unknown as CommunicationRow[];
      setRows((prev) => [...prev, ...next]);
      setHasMore(next.length >= PAGE_SIZE);
    } catch (e) {
      setLoadMoreError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setLoadingMore(false);
    }
  }

  function clearFilters() {
    setChannelFilter(new Set());
    setAudienceFilter(new Set());
    setStatusFilter(new Set());
    setTestOnly(false);
    setSearch("");
  }

  const activeFilterCount =
    channelFilter.size + audienceFilter.size + statusFilter.size + (testOnly ? 1 : 0) + (search.trim() ? 1 : 0);

  // Loaded-window KPIs (not a full-table aggregate) — cheap, computed from
  // whatever's already fetched (first page, plus anything pulled via "Load
  // more"). Good enough for an at-a-glance count; not a source of truth for
  // "total sent today" once older rows fall off the loaded window.
  const kpis = useMemo(() => {
    const todayKey = new Date().toDateString();
    let sentToday = 0;
    let failed = 0;
    let testSends = 0;
    for (const r of rows) {
      if (r.status === "sent" && new Date(r.created_at).toDateString() === todayKey) sentToday += 1;
      if (r.status === "failed") failed += 1;
      if (r.test_mode) testSends += 1;
    }
    return { sentToday, failed, testSends };
  }, [rows]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (channelFilter.size > 0 && !channelFilter.has(r.channel)) return false;
      if (!matchesAudience(r.audience, audienceFilter)) return false;
      if (statusFilter.size > 0 && !statusFilter.has(r.status)) return false;
      if (testOnly && !r.test_mode) return false;
      if (term) {
        const haystack = [r.subject, r.to_address, r.orders?.order_name, r.order_id]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [rows, channelFilter, audienceFilter, statusFilter, testOnly, search]);

  if (error) {
    return (
      <main className="ds page">
        <p className="eyebrow">Operations</p>
        <h1>Communications</h1>
        <div style={{ marginTop: 24 }}>
          <ErrorState
            title="Couldn't load communications"
            description="Something went wrong fetching data from Supabase. This is a fetch error, not an empty log — sent messages are still there."
          />
        </div>
      </main>
    );
  }

  return (
    <main className="ds page">
      <p className="eyebrow">Operations</p>
      <h1>Communications</h1>

      {rows.length === 0 ? (
        <div style={{ marginTop: 24 }}>
          <EmptyState
            icon={<IconMail className="h-12 w-12 text-ink-faint" />}
            title="No communications yet"
            description="Every email, push notification, and SMS the system sends — offers, client notices, CX alerts, issue mail — will show up here as they go out."
          />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" style={{ marginTop: 16 }}>
            <StatTile label="Sent today" value={kpis.sentToday} accent="emerald" icon={<IconMail className="h-4 w-4" />} />
            <StatTile label="Failed" value={kpis.failed} accent="red" icon={<IconAlertTriangle className="h-4 w-4" />} />
            <StatTile label="Test-mode sends" value={kpis.testSends} accent="amber" icon={<IconMail className="h-4 w-4" />} />
          </div>

          <div className="filterbar" style={{ marginTop: 16 }}>
            <FilterPopover label="Channel" count={channelFilter.size}>
              {() => (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {CHANNEL_OPTIONS.map((opt) => (
                    <label key={opt.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: ".85rem", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={channelFilter.has(opt.key)}
                        onChange={() => setChannelFilter((prev) => toggle(prev, opt.key))}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              )}
            </FilterPopover>

            <FilterPopover label="Audience" count={audienceFilter.size}>
              {() => (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {AUDIENCE_OPTIONS.map((opt) => (
                    <label key={opt.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: ".85rem", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={audienceFilter.has(opt.key)}
                        onChange={() => setAudienceFilter((prev) => toggle(prev, opt.key))}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              )}
            </FilterPopover>

            <FilterPopover label="Status" count={statusFilter.size}>
              {() => (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {STATUS_OPTIONS.map((opt) => (
                    <label key={opt.key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: ".85rem", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={statusFilter.has(opt.key)}
                        onChange={() => setStatusFilter((prev) => toggle(prev, opt.key))}
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
              )}
            </FilterPopover>

            <button type="button" className={`filter-trigger${testOnly ? " on" : ""}`} onClick={() => setTestOnly((v) => !v)}>
              🧪 Test only
            </button>

            <label className="sr-only" htmlFor="comms-search">Search</label>
            <input
              id="comms-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search subject, recipient, order…"
              style={searchStyle}
            />

            {activeFilterCount > 0 && (
              <button type="button" className="btn btn-ghost" onClick={clearFilters}>
                Clear filters
              </button>
            )}
          </div>

          <div className="card" style={{ padding: 0, overflow: "hidden", marginTop: 12 }}>
            {filtered.length === 0 && ready ? (
              <div style={{ padding: 8 }}>
                <EmptyState
                  icon={<IconMail className="h-12 w-12 text-ink-faint" />}
                  title="No communications match these filters"
                  description="Try widening your filters, or clear them to see everything loaded."
                  action={
                    <button type="button" className="btn btn-ghost" onClick={clearFilters}>
                      Clear filters
                    </button>
                  }
                />
              </div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Channel</th>
                    <th>Audience</th>
                    <th>Recipient</th>
                    <th>Order</th>
                    <th>Subject</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {!ready ? (
                    <SkeletonRows />
                  ) : (
                    filtered.map((r) => {
                      const expanded = expandedId === r.id;
                      const preview = r.subject ?? (r.body ? r.body.slice(0, 90) : null) ?? "—";
                      return (
                        <Fragment key={r.id}>
                          <tr
                            onClick={() => setExpandedId(expanded ? null : r.id)}
                            aria-expanded={expanded}
                          >
                            <td style={{ color: "var(--ink-soft)" }} title={formatDateTime(r.created_at)}>
                              {formatRelative(r.created_at)}
                            </td>
                            <td><ChannelLabel channel={r.channel} /></td>
                            <td><AudienceBadge audience={r.audience} /></td>
                            <td>
                              {/* A received reply has no recipient worth showing (it is our
                                  own inbound address); who WROTE is what the operator needs. */}
                              <span style={ellipsisStyle} title={(r.status === "received" ? r.actor : r.to_address) ?? undefined}>
                                {r.status === "received" ? `From ${r.actor ?? "unknown sender"}` : r.to_address ?? "—"}
                              </span>
                              {r.test_mode && <TestTag toAddress={r.to_address} />}
                            </td>
                            <td>
                              {r.order_id ? (
                                <Link
                                  href={`/orders/${r.order_id}`}
                                  onClick={(e) => e.stopPropagation()}
                                  style={{ fontWeight: 700, fontFamily: "var(--mono)" }}
                                >
                                  {r.orders?.order_name ?? r.order_id.slice(0, 8)}
                                </Link>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td>
                              <span style={{ ...ellipsisStyle, maxWidth: 260 }} title={preview}>
                                {preview}
                              </span>
                            </td>
                            <td><StatusBadge status={r.status} error={r.error} /></td>
                            <td>
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
                            </td>
                          </tr>
                          {expanded && (
                            <tr>
                              <td colSpan={COLS} style={{ cursor: "default", background: "var(--surface-2)" }} onClick={(e) => e.stopPropagation()}>
                                <div style={{ padding: "10px 6px", display: "grid", gap: 10 }}>
                                  {r.subject && (
                                    <div style={{ fontWeight: 700 }}>{r.subject}</div>
                                  )}
                                  <dl className="kv">
                                    <dt>To</dt><dd>{r.to_address ?? "—"}</dd>
                                    <dt>From</dt><dd>{r.actor ?? "system"}</dd>
                                    <dt>Kind</dt><dd>{r.kind}</dd>
                                    <dt>Provider</dt>
                                    <dd>{r.provider}{r.provider_message_id ? ` · ${r.provider_message_id}` : ""}</dd>
                                    {r.status === "failed" && (
                                      <>
                                        <dt>Error</dt>
                                        <dd style={{ color: "var(--crit)" }}>{r.error ?? "—"}</dd>
                                      </>
                                    )}
                                  </dl>
                                  {r.channel === "email" && r.html && (
                                    <div>
                                      <div style={{ fontSize: ".78rem", fontWeight: 700, color: "var(--ink-soft)", marginBottom: 4 }}>
                                        Rendered email
                                      </div>
                                      <iframe
                                        title={`Rendered email — ${r.subject ?? r.id}`}
                                        sandbox=""
                                        srcDoc={r.html}
                                        style={{ width: "100%", height: 500, border: "1px solid var(--line)", borderRadius: 8, background: "#fff" }}
                                      />
                                    </div>
                                  )}
                                  <div style={{ whiteSpace: "pre-wrap", fontSize: ".85rem", background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, padding: 10 }}>
                                    {r.body ?? "No body recorded."}
                                  </div>
                                  {r.order_id && (
                                    <Link href={`/orders/${r.order_id}`} className="link-subtle">
                                      View order →
                                    </Link>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            )}
          </div>

          {hasMore && (
            <div style={{ display: "flex", justifyContent: "center", marginTop: 14 }}>
              <button type="button" className="btn btn-ghost" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
          {loadMoreError && (
            <p role="alert" style={{ marginTop: 10, color: "var(--crit)", fontSize: ".85rem", textAlign: "center" }}>
              {loadMoreError}
            </p>
          )}
        </>
      )}
    </main>
  );
}

const ellipsisStyle: React.CSSProperties = {
  display: "inline-block",
  maxWidth: 200,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  verticalAlign: "bottom",
};

const searchStyle: React.CSSProperties = {
  font: ".8rem var(--sans)",
  padding: "7px 10px",
  borderRadius: 8,
  border: "1px solid var(--line-strong)",
  background: "var(--surface)",
  color: "var(--ink)",
  minWidth: 220,
};
