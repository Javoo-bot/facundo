"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import Badge from "@/components/ui/Badge";
import EmptyState from "@/components/EmptyState";
import ErrorState from "@/components/ErrorState";
import StatTile from "@/components/StatTile";
import { IconCreditCard } from "@/components/icons";
import IssueCardForm from "@/components/payments/IssueCardForm";
import type { Payout } from "@/lib/types";
import { pageTitle } from "@/lib/brand";

/** Nested-select row shape from the server page's `payouts.select("...,
 * order_assignments(order_id, orders(order_name), florists(name)))")`. */
export type PayoutRow = Payout & {
  order_assignments: {
    order_id: string;
    orders: { order_name: string | null } | null;
    florists: { name: string } | null;
  } | null;
  // Resolved server-side for leg='manual' rows (no order_assignments embed to
  // pull a florist name from — see app/(staff)/payments/page.tsx).
  manual_florist_name?: string | null;
  // Airwallex console deep-links, computed server-side (null when N/A).
  airwallex_url?: string | null; // the card
  airwallex_txn_url?: string | null; // the disputed transaction
  // Server-computed staleness gate (see lib/airwallex/liveCheckEligibility.ts).
  // eligible: real card-rail, still-active payout worth ever checking live.
  // needs_live_check: eligible AND Airwallex has never told us this card's
  // status — the exact shape of the 2026-08-11 incident (3 issued cards went
  // stale silently, one fully drawn down while the UI still said "Spent —").
  live_check_eligible?: boolean;
  needs_live_check?: boolean;
};

// Response row shape for POST /api/payouts/live-status — see that route for
// the authoritative contract. Kept local (not imported) since the route lives
// in a different engineer's in-progress change.
interface BulkLiveCheckRow {
  id: string;
  eligible: boolean;
  reason?: "ledger_or_no_card" | "card_inactive" | "test_shop";
  summary?: {
    cardStatus: string | null;
    currency: string | null;
    clearedTotal: number | null;
    pendingTotal: number | null;
    spent: boolean;
    transactions: unknown[];
    authorizations: unknown[];
    drift: { field: string; stored: string; live: string; note: string }[];
  };
  partial?: string[];
  error?: string;
}

const MAX_LIVE_CHECK_IDS = 25;

const COLS = 8;
const STATUSES: Payout["status"][] = ["pending", "held", "issued", "paid", "failed", "clawed_back"];
const STATUS_LABEL: Record<Payout["status"], string> = {
  pending: "Pending",
  held: "Held — review",
  issued: "Issued",
  paid: "Paid",
  failed: "Failed",
  clawed_back: "Clawed back",
};
const LEG_LABEL: Record<Payout["leg"], string> = {
  accept: "On accept",
  delivery: "On delivery",
  manual: "Manual",
};

// Variants per the build spec: paid/issued -> accent, pending -> neutral,
// failed -> crit, clawed_back -> warn.
function statusBadgeCls(status: Payout["status"]): string {
  switch (status) {
    case "paid":
    case "issued":
      return "badge-accent";
    case "held":
      return "badge-warn";
    case "pending":
      return "badge-neutral";
    case "failed":
      return "badge-crit";
    case "clawed_back":
      return "badge-warn";
  }
}

function legLabel(leg: string): string {
  return LEG_LABEL[leg as Payout["leg"]] ?? leg;
}

// Nullable-honest — never NaN, never a raw null. Mirrors the convention in
// components/orders/format.ts (that file is out of scope here — other
// engineers are actively retinting components/orders/** — so this is a local
// copy of the same logic, not an import).
function formatMoney(amount: number | null, currency: string | null): string {
  if (amount == null || Number.isNaN(amount)) return "—";
  return currency ? `${amount.toFixed(2)} ${currency}` : amount.toFixed(2);
}

// `currency` is free-text and nullable per schema — nothing guarantees every
// payout shares one currency. Summing raw amounts across currencies and
// slapping on a single arbitrary currency label would be a silently
// misleading total, so this buckets by currency and renders each bucket's
// sum separately (e.g. "120.00 EUR + 50.00 USD") instead of pretending one
// currency for the whole total. A null currency gets its own unlabeled
// bucket rather than being merged into a labeled one.
function formatMoneySum(entries: { amount: number | null; currency: string | null }[]): string {
  const byCurrency = new Map<string, number>();
  for (const { amount, currency } of entries) {
    if (amount == null || Number.isNaN(amount)) continue;
    const key = currency ?? "";
    byCurrency.set(key, (byCurrency.get(key) ?? 0) + amount);
  }
  if (byCurrency.size === 0) return "—";
  return Array.from(byCurrency.entries())
    .map(([currency, sum]) => (currency ? `${sum.toFixed(2)} ${currency}` : sum.toFixed(2)))
    .join(" + ");
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function SkeletonRows({ rows = 8 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i}>
          <td colSpan={COLS}>
            <div className="skeleton-row">
              <span className="skeleton" style={{ width: 70, height: 14 }} />
              <span className="skeleton" style={{ width: 120, height: 14 }} />
              <span className="skeleton" style={{ width: 90, height: 14 }} />
              <span className="skeleton" style={{ width: 70, height: 14 }} />
              <span className="skeleton" style={{ width: 60, height: 14, marginLeft: "auto" }} />
              <span className="skeleton" style={{ width: 60, height: 14 }} />
              <span className="skeleton" style={{ width: 50, height: 14 }} />
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}

// A "real", currently-usable card — used to gate the "Active cards only"
// filter. Excludes ledger-rail sentinels (never a real card), closed cards,
// fully-spent cards (the clearing webhook sets status:'paid' + card_status:
// 'USED' together — a single-use card that's been charged has no value left),
// and rows whose status isn't in the issued/paid range.
function isActiveCard(p: PayoutRow): boolean {
  return p.rail === "card"
    && !!p.provider_ref
    && !p.provider_ref.startsWith("ledger:")
    && p.card_status !== "CLOSED"
    && p.card_status !== "USED"
    && (p.status === "issued" || p.status === "paid");
}

// The Status <td>'s live-check indicator: a checked-result badge takes
// priority over the plain "flagged" badge once a manual check has run for
// this row (ephemeral, keyed by payout id — see `liveResults` state).
function LiveCheckIndicator({ payout, result }: { payout: PayoutRow; result?: BulkLiveCheckRow }) {
  if (result) {
    if (result.error) {
      return (
        <span className="badge badge-warn" style={{ marginLeft: 6 }} title={result.error}>
          Couldn&apos;t check
        </span>
      );
    }
    // Shouldn't normally happen — we only ever send already-eligible ids —
    // but the server is the source of truth, so don't assume and don't crash.
    if (result.eligible === false || !result.summary) return null;
    if (result.summary.drift.length > 0) {
      return (
        <span
          className="badge badge-crit"
          style={{ marginLeft: 6 }}
          title={`Airwallex disagrees on: ${result.summary.drift.map((d) => d.field).join(", ")}`}
        >
          Drift found
        </span>
      );
    }
    return (
      <span style={{ marginLeft: 6, fontSize: ".72rem", color: "var(--ink-soft)" }}>
        Confirmed match
      </span>
    );
  }
  if (payout.needs_live_check) {
    return (
      <span
        className="badge badge-warn"
        style={{ marginLeft: 6 }}
        title="Airwallex has never confirmed this card's state — the stored record may be stale."
      >
        Unconfirmed
      </span>
    );
  }
  return null;
}

export default function PaymentsLedger({
  payouts, error, canIssueCard = false,
}: {
  payouts: PayoutRow[];
  error: string | null;
  canIssueCard?: boolean;
}) {
  // One-frame skeleton on mount — matches components/orders/OrdersClient.tsx's
  // pattern: data is already server-fetched (no client refetch).
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  const [statusFilter, setStatusFilter] = useState<Payout["status"] | null>(null);
  const [activeCardsOnly, setActiveCardsOnly] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);

  // Ephemeral results from the manual "Check flagged live" action — never
  // persisted, never written server-side (matches LiveAirwallexPanel: no
  // router.refresh(), because nothing server-side changed). Cleared on
  // unmount only; a stale badge from a prior click stays until re-checked.
  const [liveResults, setLiveResults] = useState<Map<string, BulkLiveCheckRow>>(new Map());
  const [liveCheckBusy, setLiveCheckBusy] = useState(false);
  const [liveCheckErr, setLiveCheckErr] = useState<string | null>(null);

  // The card picker's florist roster, fetched the first time an admin opens the
  // "Issue a card" form rather than on every render of this page (it was the
  // full roster, paged, for a form that mostly never opens). null = not loaded
  // yet, which is what the form's "Loading florists…" state keys off.
  const [floristOptions, setFloristOptions] = useState<{ id: string; name: string }[] | null>(null);
  const loadFloristOptions = useCallback(async () => {
    if (floristOptions !== null) return;
    try {
      // includeExcluded: this picker has always listed permanently-excluded
      // shops (you can still owe one money); withEmail=0 because issuing a card
      // doesn't need a contactable address.
      const res = await fetch("/api/florists/options?limit=1000&withEmail=0&includeExcluded=1");
      setFloristOptions(res.ok ? (await res.json()).florists ?? [] : []);
    } catch {
      setFloristOptions([]); // the form still works — you just type the name
    }
  }, [floristOptions]);

  const kpis = useMemo(() => {
    const issued: { amount: number | null; currency: string | null }[] = [];
    const paid: { amount: number | null; currency: string | null }[] = [];
    const pending: { amount: number | null; currency: string | null }[] = [];
    let failed = 0;
    for (const p of payouts) {
      const entry = { amount: p.amount, currency: p.currency };
      if (p.status === "issued") issued.push(entry);
      else if (p.status === "paid") paid.push(entry);
      else if (p.status === "pending") pending.push(entry);
      else if (p.status === "failed") failed += 1;
    }
    return {
      issuedLabel: formatMoneySum(issued),
      paidLabel: formatMoneySum(paid),
      pendingLabel: formatMoneySum(pending),
      failedCount: failed,
    };
  }, [payouts]);

  const activeFilterCount = (statusFilter ? 1 : 0) + (activeCardsOnly ? 1 : 0);
  function clearFilters() {
    setStatusFilter(null);
    setActiveCardsOnly(false);
  }

  const filtered = useMemo(() => {
    let rows = payouts;
    if (statusFilter) rows = rows.filter((p) => p.status === statusFilter);
    if (activeCardsOnly) rows = rows.filter(isActiveCard);
    return rows;
  }, [payouts, statusFilter, activeCardsOnly]);

  // Currently-visible flagged rows — the bulk action only ever targets what's
  // on screen, not the full unfiltered set.
  const flaggedIds = useMemo(
    () => filtered.filter((p) => p.needs_live_check).map((p) => p.id),
    [filtered],
  );
  const flaggedIdsToSend = flaggedIds.slice(0, MAX_LIVE_CHECK_IDS);

  async function checkFlaggedLive() {
    setLiveCheckBusy(true);
    setLiveCheckErr(null);
    try {
      const r = await fetch("/api/payouts/live-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: flaggedIdsToSend }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setLiveCheckErr(j.error ?? "Could not check live.");
        return;
      }
      const results: BulkLiveCheckRow[] = j.results ?? [];
      setLiveResults((prev) => {
        const next = new Map(prev);
        for (const row of results) next.set(row.id, row);
        return next;
      });
    } catch {
      setLiveCheckErr("Network error.");
    } finally {
      setLiveCheckBusy(false);
    }
  }

  if (error) {
    return (
      <main className="ds page">
        <p className="eyebrow">Operations</p>
        <h1>{pageTitle("Payments")}</h1>
        <div style={{ marginTop: 24 }}>
          <ErrorState
            title="Couldn't load payments"
            description="Something went wrong fetching data from Supabase. This is a fetch error, not an empty ledger — your payouts are still there."
          />
        </div>
      </main>
    );
  }

  return (
    <main className="ds page">
      <p className="eyebrow">Operations</p>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <h1>{pageTitle("Payments")}</h1>
        {canIssueCard && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setIssueOpen((v) => !v);
              void loadFloristOptions();
            }}
          >
            {issueOpen ? "Cancel" : "Issue a card"}
          </button>
        )}
      </div>
      {canIssueCard && issueOpen && (
        <div className="card" style={{ marginTop: 12 }}>
          {floristOptions === null ? (
            <p style={{ color: "var(--ink-soft)", fontSize: ".85rem", margin: 0 }}>Loading florists…</p>
          ) : (
            <IssueCardForm floristOptions={floristOptions} onDone={() => setIssueOpen(false)} />
          )}
        </div>
      )}

      {payouts.length === 0 ? (
        <div style={{ marginTop: 24 }}>
          <EmptyState
            icon={<IconCreditCard className="h-12 w-12 text-ink-faint" />}
            title="No payouts yet"
            description="They appear once orders are accepted and paid."
          />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" style={{ marginTop: 16 }}>
            <StatTile label="Issued" value={kpis.issuedLabel} accent="slate" icon={<IconCreditCard className="h-4 w-4" />} />
            <StatTile label="Paid" value={kpis.paidLabel} accent="emerald" icon={<IconCreditCard className="h-4 w-4" />} />
            <StatTile label="Pending" value={kpis.pendingLabel} accent="amber" icon={<IconCreditCard className="h-4 w-4" />} />
            <StatTile label="Failed" value={kpis.failedCount} accent="red" icon={<IconCreditCard className="h-4 w-4" />} />
          </div>

          <div className="filterbar" style={{ marginTop: 16 }}>
            <label className="sr-only" htmlFor="payments-status-filter">Status</label>
            <select
              id="payments-status-filter"
              value={statusFilter ?? ""}
              onChange={(e) => setStatusFilter((e.target.value || null) as Payout["status"] | null)}
              className={`filter-trigger${statusFilter ? " on" : ""}`}
              style={selectStyle}
            >
              <option value="">All statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
              ))}
            </select>

            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: ".8rem" }}>
              <input type="checkbox" checked={activeCardsOnly} onChange={(e) => setActiveCardsOnly(e.target.checked)} />
              Active cards only
            </label>

            {activeFilterCount > 0 && (
              <button type="button" className="btn btn-ghost" onClick={clearFilters}>
                Clear filters
              </button>
            )}

            {flaggedIds.length > 0 && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={liveCheckBusy}
                onClick={() => void checkFlaggedLive()}
                title="Ask Airwallex directly for these cards' current status. Read-only — nothing is written to the record."
              >
                {liveCheckBusy
                  ? "Checking…"
                  : flaggedIds.length > MAX_LIVE_CHECK_IDS
                    ? `Check first ${MAX_LIVE_CHECK_IDS} of ${flaggedIds.length} flagged`
                    : `Check ${flaggedIds.length} flagged live`}
              </button>
            )}
          </div>

          {flaggedIds.length > 0 && (
            <p style={{ fontSize: ".72rem", color: "var(--ink-soft)", marginTop: 4 }}>
              Results shown here aren&apos;t saved — nothing was written to the record.
              {liveCheckErr && <span style={{ color: "var(--crit)", marginLeft: 8 }}>{liveCheckErr}</span>}
            </p>
          )}

          <div className="card" style={{ padding: 0, overflow: "hidden", marginTop: 12 }}>
            {filtered.length === 0 && ready ? (
              <div style={{ padding: 8 }}>
                <EmptyState
                  icon={<IconCreditCard className="h-12 w-12 text-ink-faint" />}
                  title="No payouts match this filter"
                  description="Try a different status, or clear the filter to see all payouts."
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
                    <th>Order</th>
                    <th>Florist</th>
                    <th>Leg</th>
                    <th className="text-right">Amount</th>
                    <th>Status</th>
                    <th>Rail</th>
                    <th>Date</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {!ready ? (
                    <SkeletonRows />
                  ) : (
                    filtered.map((p) => {
                      const orderId = p.order_assignments?.order_id ?? null;
                      const orderLabel = p.order_assignments?.orders?.order_name ?? orderId;
                      const floristName = p.order_assignments?.florists?.name ?? p.manual_florist_name ?? null;
                      return (
                        <tr key={p.id} onClick={() => { location.href = `/payments/${p.id}`; }}>
                          <td onClick={(e) => e.stopPropagation()}>
                            {orderId ? (
                              <Link href={`/orders/${orderId}`} style={{ fontWeight: 700, fontFamily: "var(--mono)" }}>
                                {orderLabel ?? orderId.slice(0, 8)}
                              </Link>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td>{floristName ?? "—"}</td>
                          <td style={{ color: "var(--ink-soft)" }}>{legLabel(p.leg)}</td>
                          <td className="text-right" style={{ fontWeight: 600 }}>{formatMoney(p.amount, p.currency)}</td>
                          <td>
                            <Badge info={{ cls: statusBadgeCls(p.status), label: STATUS_LABEL[p.status] }} />
                            {p.dispute_status && (
                              <span className="badge badge-crit" style={{ marginLeft: 6 }} title="Card transaction dispute">
                                Dispute: {p.dispute_status}
                              </span>
                            )}
                            <LiveCheckIndicator payout={p} result={liveResults.get(p.id)} />
                          </td>
                          <td style={{ color: "var(--ink-soft)" }}>{p.rail ?? "—"}</td>
                          <td style={{ color: "var(--ink-soft)" }}>{formatDateTime(p.created_at)}</td>
                          <td onClick={(e) => e.stopPropagation()}>
                            {/* Full record — card reveal/close, deep-links and events — lives on the payment page. */}
                            <Link href={`/payments/${p.id}`} className="link-subtle" title="Open the payment record">
                              View →
                            </Link>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </main>
  );
}

const selectStyle: React.CSSProperties = {
  font: "600 .8rem/1 var(--sans)",
  padding: "7px 10px",
  borderRadius: 8,
  border: "1px solid var(--line-strong)",
  background: "var(--surface)",
  color: "var(--ink-soft)",
};
