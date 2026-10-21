"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import EmptyState from "@/components/EmptyState";
import ErrorState from "@/components/ErrorState";
import Badge from "@/components/ui/Badge";
import FilterPopover from "@/components/orders/FilterPopover";
import { IconCheckCircle } from "@/components/icons";
import { toneBadgeClass } from "@/lib/orderVisual";
import {
  applyControlFilters,
  controlChip,
  destinationOptions,
  statusOptions,
  showContactFlorist,
  timeLeftLabel,
  activeFilterCount,
  type ControlRow,
} from "@/lib/controlPanel";
import { pageTitle } from "@/lib/brand";

// The Control panel table.
//
// FOUR COLUMNS, ONE BUTTON, AND THE BUTTON IS NOT ON EVERY ROW.
//
// The columns are the order number, where it is going, what state it is in and
// when it is due — the things anyone can read without being taught this system.
// The status words are /orders' own chips, rendered by the same function, so an
// order reads identically on both pages.
//
// The button appears only where a person is genuinely needed: nobody left to
// email, and somebody we emailed never answered. See lib/controlPanel.ts. A row
// without it is not broken — it is an order the machine is still working, or
// one whose next move is on the order page.

/** The clock. Coarse on purpose: the Time left column is measured in hours and
 * days, so a minute is plenty of resolution, and a number that changes every
 * second drags the eye to whichever row happens to be counting. Starts null so
 * the server render and the first client render agree. */
function useMinuteClock(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Delivery day without a time of day. The hour was noise on a table sorted by
 * urgency — "3 sept" plus "Overdue" says everything the operator acts on, and
 * the exact window is on the order. */
function formatDay(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleDateString([], { month: "short", day: "numeric" });
}

const inputStyle: CSSProperties = {
  font: "600 .8rem/1 var(--sans)",
  padding: "7px 10px",
  borderRadius: 8,
  border: "1px solid var(--line-strong)",
  background: "var(--surface)",
  color: "var(--ink)",
};

const dateInputStyle: CSSProperties = {
  font: ".8rem var(--sans)",
  padding: "5px 8px",
  borderRadius: 6,
  border: "1px solid var(--line-strong)",
  background: "var(--surface)",
  color: "var(--ink)",
};

export default function HomeClient({
  rows,
  fetchError,
}: {
  /** The whole attention queue, already ranked by deadline on the server. */
  rows: ControlRow[];
  fetchError: boolean;
}) {
  const now = useMinuteClock();

  // Filtering runs here rather than on the server: the queue is already in
  // memory, the page is force-dynamic (so a URL round-trip would re-run every
  // query per keystroke), and an operator narrowing a list wants it to happen
  // as they type.
  const [order, setOrder] = useState("");
  const [destination, setDestination] = useState<string | null>(null);
  const [status, setStatus] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  // Drafts, so typing a From date does not filter the list to nothing before
  // the To date has been entered.
  const [fromDraft, setFromDraft] = useState("");
  const [toDraft, setToDraft] = useState("");

  const filters = useMemo(
    () => ({ order, destination, status: [...status], from, to }),
    [order, destination, status, from, to]
  );
  const visible = useMemo(() => applyControlFilters(rows, filters), [rows, filters]);
  const destinations = useMemo(() => destinationOptions(rows), [rows]);
  const statuses = useMemo(() => statusOptions(rows), [rows]);
  const activeCount = activeFilterCount(filters);
  const callable = useMemo(() => visible.filter(showContactFlorist).length, [visible]);

  function toggleStatus(label: string) {
    setStatus((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  function clearFilters() {
    setOrder("");
    setDestination(null);
    setStatus(new Set());
    setFrom("");
    setTo("");
    setFromDraft("");
    setToDraft("");
  }

  if (fetchError) {
    return (
      <div className="ds page">
        <ErrorState
          title="Couldn't load the Control panel"
          description="Something went wrong fetching data from Supabase. This is a fetch error, not an empty account."
        />
      </div>
    );
  }

  return (
    // .page-wide is `.page` with --maxw-wide (1440px) in place of --maxw.
    <div className="ds page-wide">
      <p className="eyebrow">Staff console</p>
      <h1>{pageTitle("Control panel")}</h1>
      <p style={{ color: "var(--ink-soft)", marginTop: 6, fontSize: ".9rem" }}>
        {rows.length === 0
          ? "Nothing needs you. Every order is running on its own."
          : callable === 0
            ? `${rows.length} ${rows.length === 1 ? "order is" : "orders are"} being worked. Nothing needs a phone call right now.`
            : `${callable} ${callable === 1 ? "order needs" : "orders need"} a call. Soonest delivery first — start at the top.`}
      </p>

      <div className="filterbar" style={{ marginTop: 20 }}>
        <input
          value={order}
          onChange={(e) => setOrder(e.target.value)}
          placeholder="Order number"
          aria-label="Filter by order number"
          style={{ ...inputStyle, minWidth: 170, fontWeight: 400 }}
        />

        <FilterPopover label="Destination" count={destination ? 1 : 0}>
          {(close) => (
            <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 260, overflowY: "auto" }}>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ justifyContent: "flex-start", border: "none" }}
                onClick={() => { setDestination(null); close(); }}
              >
                All destinations
              </button>
              {destinations.map((d) => (
                <button
                  key={d}
                  type="button"
                  className="btn btn-ghost"
                  style={{ justifyContent: "flex-start", border: "none", fontWeight: destination === d ? 700 : 400 }}
                  onClick={() => { setDestination(d); close(); }}
                >
                  {d}
                </button>
              ))}
              {destinations.length === 0 && (
                <p style={{ color: "var(--ink-faint)", fontSize: ".8rem" }}>No destinations to filter by.</p>
              )}
            </div>
          )}
        </FilterPopover>

        <FilterPopover label="Status" count={status.size}>
          {() => (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 260, overflowY: "auto" }}>
              {statuses.map((s) => (
                <label key={s} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: ".85rem", cursor: "pointer" }}>
                  <input type="checkbox" checked={status.has(s)} onChange={() => toggleStatus(s)} />
                  {s}
                </label>
              ))}
              {statuses.length === 0 && (
                <p style={{ color: "var(--ink-faint)", fontSize: ".8rem" }}>No statuses to filter by.</p>
              )}
            </div>
          )}
        </FilterPopover>

        <FilterPopover label="Delivery date" count={(from ? 1 : 0) + (to ? 1 : 0)}>
          {(close) => (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label style={{ fontSize: ".78rem", color: "var(--ink-faint)", display: "flex", flexDirection: "column", gap: 4 }}>
                From
                <input type="date" value={fromDraft} onChange={(e) => setFromDraft(e.target.value)} style={dateInputStyle} />
              </label>
              <label style={{ fontSize: ".78rem", color: "var(--ink-faint)", display: "flex", flexDirection: "column", gap: 4 }}>
                To
                <input type="date" value={toDraft} onChange={(e) => setToDraft(e.target.value)} style={dateInputStyle} />
              </label>
              <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => { setFromDraft(""); setToDraft(""); setFrom(""); setTo(""); }}
                >
                  Clear
                </button>
                <button
                  type="button"
                  className="btn btn-solid"
                  onClick={() => { setFrom(fromDraft); setTo(toDraft); close(); }}
                >
                  Apply
                </button>
              </div>
            </div>
          )}
        </FilterPopover>

        {activeCount > 0 && (
          <>
            <button type="button" className="btn btn-ghost" onClick={clearFilters}>
              Clear filters
            </button>
            <span style={{ color: "var(--ink-faint)", fontSize: ".8rem" }}>
              {visible.length} of {rows.length}
            </span>
          </>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden", marginTop: 12 }}>
        {visible.length === 0 ? (
          <div style={{ padding: 8 }}>
            <EmptyState
              icon={<IconCheckCircle className="h-12 w-12 text-ink-faint" />}
              title={rows.length === 0 ? "Nothing needs attention" : "No orders match these filters"}
              description={
                rows.length === 0
                  ? "All orders are on track — nothing needs a human right now."
                  : "Every order that needs you is filtered out. Clear the filters to see the whole queue."
              }
            />
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Destination</th>
                <th>Status</th>
                <th>Delivery date</th>
                <th>Time left</th>
                {/* Blank: the four named columns are the table; the button is
                    the action on it, and it is not on every row. */}
                <th style={{ textAlign: "right" }} aria-label="Action" />
              </tr>
            </thead>
            <tbody>
              {visible.map((o) => {
                const chip = controlChip(o, now ?? undefined);
                const canCall = showContactFlorist(o);
                return (
                  <tr
                    key={o.id}
                    className={`row-tone-${o.severity}`}
                    // Why this order is in the queue, in cxAttention's words.
                    // Not a label: that vocabulary names actions this page does
                    // not offer. It survives here so the detail is reachable.
                    title={o.reason}
                    onClick={() => { location.href = `/orders/${o.id}`; }}
                  >
                    <td>
                      <Link href={`/orders/${o.id}`} style={{ fontWeight: 700, fontFamily: "var(--mono)" }}>
                        {o.orderName ?? o.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td>{o.destination}</td>
                    <td>
                      <span title={chip.label}>
                        <Badge info={{ cls: toneBadgeClass(chip.tone), label: chip.label }} />
                      </span>
                    </td>
                    <td style={{ color: "var(--ink-soft)", whiteSpace: "nowrap" }}>{formatDay(o.deliveryAt)}</td>
                    <td style={{ whiteSpace: "nowrap", fontWeight: 600 }}>
                      {/* Rendered only once the client clock exists, so SSR and
                          first paint agree; the server has no "now". */}
                      {now == null ? "" : timeLeftLabel(o.deliveryAt, now)}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {canCall && (
                        // The only button on the page. Goes to the call screen
                        // as it already is — no ?shop=, because the card picks
                        // the warmest shop that has not refused. stopPropagation
                        // so the button is the call and the rest of the row is
                        // the order.
                        <Link
                          href={`/orders/${o.id}/call`}
                          className="op-act"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Contact florist
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
