"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import type { Order } from "@/lib/types";
import { ORDER_STATUSES, ORDER_STATUS_LABEL, type AssignmentStatus, type OrderStatus } from "@/lib/orderStatus";
import Badge from "@/components/ui/Badge";
import EmptyState from "@/components/EmptyState";
import StatTile from "@/components/StatTile";
import { IconAlertTriangle, IconCreditCard, IconLayers, IconReceipt } from "@/components/icons";
import FilterPopover from "@/components/orders/FilterPopover";
import AddByNumber from "@/components/orders/AddByNumber";
import { deliveryDeadlineLabel, deriveCity, deriveCountry, deliverySeverity, findAcceptedAssignment } from "@/components/orders/orderDerive";
import { orderTone, primaryChip, secondaryChips, toneBadgeClass, toneRowClass, type OrderVisualInput } from "@/lib/orderVisual";
import { formatMoney } from "@/components/orders/format";
import { splitOrderTags } from "@/lib/orderTags";
import { pageTitle } from "@/lib/brand";

/** Row shape from the server page's orders query, plus a server-computed
 * `moneyHeld` flag (held/failed payout on the order).
 *
 * A `Pick`, not the whole `Order`: the page selects LIST_COLUMNS, not `*` —
 * `raw` alone was ~13 KB a row and nothing here reads it. Keeping this in step
 * with LIST_COLUMNS is what stops a field being rendered that was never
 * fetched (it would silently render as undefined). */
export type OrderRow = Pick<
  Order,
  | "id"
  | "order_name"
  | "shopify_created_at"
  | "created_at"
  | "delivery_at"
  | "delivery_window"
  | "delivery_area"
  | "delivery_address"
  | "recipient_name"
  | "total"
  | "currency"
  | "financial_status"
  | "fulfillment_status"
  | "status"
  | "tags"
  | "worklist_at"
> & {
  order_assignments: Array<{
    status: AssignmentStatus;
    florist_id: string;
    rank: number | null;
    payout_price: number | null;
    payout_percent: number | null;
    florists: { name: string } | null;
  }>;
  moneyHeld?: boolean;
};

type SortKey = "created" | "deliver" | "total" | "status";

/** The URL-param state the server already resolved (validated status values,
 * the tags seed-vs-literal decision, etc.) — the source of truth for every
 * control below. Because `/orders` is `force-dynamic`, a `router.replace` to
 * a new URL re-runs the server page and this whole object is replaced with
 * fresh values, so most controls just read straight off these props rather
 * than keeping parallel local state. */
export interface OrdersInitialParams {
  sort: SortKey;
  dir: "asc" | "desc";
  status: OrderStatus[];
  completed: boolean;
  fulfilled: boolean;
  tags: string[];
  /** True once `tags` has appeared in the URL (even as `tags=`) — i.e. the
   * user has touched the Tags filter at least once, so it should no longer
   * be re-seeded from `activeOrderTags` on the next navigation. */
  tagsProvided: boolean;
  /** `worklist=1` — showing ONLY the explicitly picked orders. */
  worklistOnly: boolean;
  /** `gate=0` — the working-set gate is off for this view (show everything). */
  gateOff: boolean;
  q: string;
  area: string;
  payment: string;
  from: string;
  to: string;
}

const COLS = 7;

// Sensible initial direction the first time a column is selected (not on
// subsequent clicks, which just flip the current direction).
const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  created: "desc",
  deliver: "asc",
  total: "desc",
  status: "asc",
};

/** The shared-keystone input for one order row. candidateCount = assignment count
 * (0 on a `matched` order ⇒ matching produced nothing); moneyHeld is server-fed. */
function toVisual(o: OrderRow): OrderVisualInput {
  return {
    status: o.status,
    delivery_at: o.delivery_at,
    assignments: o.order_assignments ?? [],
    candidateCount: (o.order_assignments ?? []).length,
    moneyHeld: o.moneyHeld ?? false,
  };
}

// "Assigned" means accepted — a candidate that's merely been sent/opened an
// offer is a reach-out in progress, not a florist to hand the order to yet
// (see findAcceptedAssignment). The placeholder names what's actually
// happening instead of implying nobody's been contacted.
function floristDisplay(status: OrderStatus, floristName: string | null): string {
  if (floristName) return floristName;
  if (status === "received" || status === "matched") return "Matching…";
  if (status === "reaching_out") return "Awaiting acceptance";
  return "—";
}

function SkeletonRows({ rows = 8 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i}>
          <td colSpan={COLS}>
            <div className="skeleton-row">
              <span className="skeleton" style={{ width: 60, height: 14 }} />
              <span className="skeleton" style={{ width: 70, height: 14 }} />
              <span className="skeleton" style={{ width: 130, height: 14 }} />
              <span className="skeleton" style={{ width: 90, height: 14 }} />
              <span className="skeleton" style={{ width: 100, height: 14 }} />
              <span className="skeleton" style={{ width: 70, height: 14, marginLeft: "auto" }} />
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}

export default function OrdersClient({
  orders,
  totalCount,
  page,
  pageSize,
  canUseMockTool = false,
  isAdmin = false,
  activeOrderTags = [],
  hiddenByGate = 0,
  appliedTags = [],
  worklistCount = 0,
  fullSweep = null,
  initialParams,
}: {
  /** This page's rows only (server-paginated, filtered, and sorted). */
  orders: OrderRow[];
  /** Total matching rows across all pages (for the pagination footer). */
  totalCount: number;
  /** 1-based current page. */
  page: number;
  pageSize: number;
  /** ops/admin — shows the mock-order tool. Its florist picker is fetched on
   * demand (see loadMockFlorists) rather than shipped with every render; the
   * eager roster was 1,189 rows on a page that mostly never opens the tool. */
  canUseMockTool?: boolean;
  /** Admin-only: shows the bulk-DELETE action. Row checkboxes themselves are
   * available to all staff, because they also drive the working-set actions. */
  isAdmin?: boolean;
  /** Live state of the full-table Shopify reconcile (app_settings.reconcile_all_*).
   *  `mode` non-null means a pass is armed and running on the worker's cron. */
  fullSweep?: { mode: string | null; stats: { swept?: number; closed?: number; conflicts?: number; errors?: number; finishedAt?: string } | null } | null;
  /** Staff-configured active-tags set (Settings → Active order tags) — shown
   * as a hint in the Tags popover when `tags` hasn't been touched, since
   * that's what the server seeded the filter from (see page.tsx). */
  activeOrderTags?: string[];
  /** How many orders match every OTHER filter but were excluded by the
   *  WORKING-SET gate (tags ∪ explicitly picked orders). Surfaced as a banner
   *  so an empty list is never mistaken for "no work" — see page.tsx for how
   *  it's counted. 0 hides the banner. */
  hiddenByGate?: number;
  /** The tag values actually applied to this query (post-sanitize), named in
   *  the banner so staff can see WHICH tag is filtering them out. */
  appliedTags?: string[];
  /** How many orders are in the EXPLICIT half of the working set (picked by
   *  number or by ticking a row). Drives the "Working set: N" chip. */
  worklistCount?: number;
  /** The server-resolved param state driving every filter/sort control. */
  initialParams: OrdersInitialParams;
}) {
  // One-frame skeleton on mount — see brief: "skeleton rows while loading".
  // This page's data is server-fetched (no client refetch on mount), so this
  // mostly exists to keep the loading affordance consistent with other
  // screens and to avoid a layout jump if hydration is slow on low-power
  // devices.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Every filter/sort control funnels through this: it patches the current
  // URL's query string and does a `router.replace` (no history entry, no
  // scroll reset). Since the page is `force-dynamic`, that replace re-runs
  // the server fetch and this component re-renders with fresh props.
  // `updates[key] === null` deletes that key; any string (including "")
  // sets it literally — that distinction is what lets the Tags filter tell
  // "cleared to empty" apart from "not touched, use the default seed".
  const updateParams = useCallback(
    (updates: Record<string, string | null>, opts?: { resetPage?: boolean }) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      if (opts?.resetPage !== false) next.delete("page");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  const goToPage = useCallback(
    (p: number) => updateParams({ page: p > 1 ? String(p) : null }, { resetPage: false }),
    [updateParams]
  );

  // Dev/test tool: generate a mock order (lands in `matched` with candidates) to
  // walk the whole loop, or clear all mock orders.
  const [mockBusy, setMockBusy] = useState<"gen" | "clear" | null>(null);
  // Optional florist to pin as the top candidate on the next mock order ("" = random).
  const [mockFloristId, setMockFloristId] = useState("");
  // Deadline preset for the next mock order ("" = the default random 1–3 days).
  // Anything else pins delivery_at and puts the order in the working set, so the
  // wave engine actually works it — that pairing is the whole point, so the two
  // are never chosen separately. See QA/A2-deadline-handover-test.md.
  const [mockDeadline, setMockDeadline] = useState("");
  const genMock = async () => {
    setMockBusy("gen");
    try {
      const res = await fetch("/api/dev/mock-order", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(mockFloristId ? { floristId: mockFloristId } : {}),
          ...(mockDeadline ? { deliveryInHours: Number(mockDeadline), intoWorkingSet: true } : {}),
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.orderId) router.push(`/orders/${j.orderId}`);
      else console.error("mock-order:", j.error);
    } finally { setMockBusy(null); }
  };
  const clearMocks = async () => {
    setMockBusy("clear");
    try {
      await fetch("/api/dev/mock-order", { method: "DELETE" });
      router.refresh();
    } finally { setMockBusy(null); }
  };

  // Pull a real order straight from Shopify by id (or #name) and import it.
  const [pullId, setPullId] = useState("");
  const [pullBusy, setPullBusy] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  const pullOrder = async () => {
    const id = pullId.trim();
    if (!id || pullBusy) return;
    setPullBusy(true);
    setPullError(null);
    try {
      const res = await fetch("/api/orders/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId: id }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.orderId) router.push(`/orders/${j.orderId}`);
      else setPullError(j.error ?? `Import failed (${res.status}).`);
    } catch (e) {
      setPullError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setPullBusy(false);
    }
  };

  // Admin "Reconcile all" — arm the worker's full-table catch-up sweep. Unlike
  // "Reconcile now" (which only reaches ~14d back) this walks EVERY order and
  // aligns its status with Shopify. It runs on the worker's cron over ~an hour,
  // so this call only arms it; `dry` reports what would change without writing.
  const [allBusy, setAllBusy] = useState<string | null>(null);
  const reconcileAll = async (mode: "dry" | "apply" | "stop") => {
    if (allBusy) return;
    if (mode === "apply" && !confirm(
      "Reconcile ALL orders against Shopify and apply the changes?\n\n" +
      "Every order fulfilled or archived in Shopify will be closed, and any pending " +
      "approval on it resolved. Runs over ~an hour on the cron; you can stop it at any time."
    )) return;
    setAllBusy(mode); setReconcileMsg(null); setReconcileErr(null);
    try {
      const res = await fetch("/api/orders/reconcile", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ all: mode }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setReconcileErr(j.error ?? `Failed (${res.status}).`); return; }
      setReconcileMsg(
        mode === "stop" ? "Full reconcile stopped."
          : mode === "dry" ? "Dry run armed — it sweeps ~60 orders a minute; check back for the report."
          : "Full reconcile armed — it sweeps ~60 orders a minute and stops on its own."
      );
      router.refresh();
    } catch (e) {
      setReconcileErr(e instanceof Error ? e.message : "Network error.");
    } finally {
      setAllBusy(null);
    }
  };

  // Admin "Reconcile now" — force the ingest worker's reconcile sweep (backfill
  // orders missed by webhook + re-check parked orders for late tags) instead of
  // waiting for the hourly cron. Shows what it did, then refreshes the list.
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const [reconcileMsg, setReconcileMsg] = useState<string | null>(null);
  const [reconcileErr, setReconcileErr] = useState<string | null>(null);
  const reconcileNow = async () => {
    if (reconcileBusy) return;
    setReconcileBusy(true); setReconcileMsg(null); setReconcileErr(null);
    try {
      const res = await fetch("/api/orders/reconcile", { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setReconcileErr(j.error ?? `Reconcile failed (${res.status}).`); return; }
      if (!j.ran) {
        setReconcileMsg(
          j.reason === "shopify-creds-unset" ? "Shopify isn't configured on the worker."
          : j.reason === "recently-ran" ? "A reconcile just ran or is in progress — try again in a moment."
          : "Skipped (already running).",
        );
      } else {
        const parts = [
          `${j.backfilled?.length ?? 0} missing order(s) re-queued`,
          `${j.parkedChecked ?? 0} parked checked`,
          `${j.healed?.length ?? 0} matched`,
        ];
        // Only shown when the worker actually restored tags, so a routine sweep
        // (and an older worker that doesn't send the field) stays quiet.
        if (j.tagsBackfilled?.length) parts.push(`${j.tagsBackfilled.length} tag(s) restored`);
        setReconcileMsg(`Reconciled: ${parts.join(" · ")}.`);
        router.refresh();
      }
    } catch (e) {
      setReconcileErr(e instanceof Error ? e.message : "Network error.");
    } finally {
      setReconcileBusy(false);
    }
  };

  // Row selection drives two things: the working-set actions (all staff) and
  // bulk delete (admin only — soft-delete via /api/orders/delete, reversible
  // from each order's Restore). Operates on the current page's selection only —
  // "select all visible" means "select all rows on this page" (there are only
  // ever this-page rows to select).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingBulkDelete, setConfirmingBulkDelete] = useState(false);
  const [bulkDeleteBusy, setBulkDeleteBusy] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState<string | null>(null);
  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const bulkDelete = async () => {
    if (!selected.size) return;
    setBulkDeleteBusy(true); setBulkDeleteError(null);
    try {
      const res = await fetch("/api/orders/delete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: [...selected] }),
      });
      if (!res.ok) setBulkDeleteError((await res.json().catch(() => ({}))).error ?? "Failed to delete the selected orders.");
      else { setSelected(new Set()); setConfirmingBulkDelete(false); router.refresh(); }
    } catch {
      setBulkDeleteError("Network error — please retry.");
    } finally {
      setBulkDeleteBusy(false);
    }
  };

  // Working set — add/remove the selected rows. This is what tells the ingest
  // worker, the CX queue, and this list's default view which orders to actually
  // operate on (union'd with Settings → Active order tags). Available to all
  // staff: it selects work, it doesn't destroy anything, and removing an order
  // never rewinds work already in flight.
  const [worklistBusy, setWorklistBusy] = useState<"add" | "remove" | null>(null);
  const [worklistError, setWorklistError] = useState<string | null>(null);
  const setWorklist = async (remove: boolean) => {
    if (!selected.size) return;
    setWorklistBusy(remove ? "remove" : "add");
    setWorklistError(null);
    try {
      const res = await fetch("/api/orders/worklist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: [...selected], remove }),
      });
      if (!res.ok) {
        setWorklistError((await res.json().catch(() => ({}))).error ?? "Failed to update the working set.");
      } else {
        setSelected(new Set());
        router.refresh();
      }
    } catch {
      setWorklistError("Network error — please retry.");
    } finally {
      setWorklistBusy(null);
    }
  };

  // The mock-order tool's florist picker, fetched the first time the tool is
  // actually used rather than shipped with every render of this page. The
  // eager version pulled the whole 1,189-row roster into the RSC payload on
  // every orders-list load, for a control most loads never touch.
  const [mockFlorists, setMockFlorists] = useState<Array<{ id: string; name: string }>>([]);
  const [mockFloristsLoaded, setMockFloristsLoaded] = useState(false);
  const loadMockFlorists = useCallback(async () => {
    if (mockFloristsLoaded) return;
    setMockFloristsLoaded(true);
    try {
      const res = await fetch("/api/florists/options?limit=1000");
      if (res.ok) setMockFlorists((await res.json()).florists ?? []);
    } catch {
      // Non-fatal: the picker just stays on "Random florist", which is its
      // default behaviour anyway.
    }
  }, [mockFloristsLoaded]);

  const { sort, dir, completed: showCompleted, fulfilled: showFulfilled } = initialParams;
  const statusFilter = useMemo(() => new Set(initialParams.status), [initialParams.status]);
  const tagSelection = useMemo(
    () => new Set(initialParams.tags.map((t) => t.trim().toLowerCase()).filter(Boolean)),
    [initialParams.tags]
  );

  function toggleStatus(s: OrderStatus) {
    const next = new Set(statusFilter);
    if (next.has(s)) next.delete(s); else next.add(s);
    updateParams({ status: next.size ? [...next].join(",") : null });
  }

  function toggleTag(tag: string) {
    const key = tag.trim().toLowerCase();
    const next = new Set(tagSelection);
    if (next.has(key)) next.delete(key); else next.add(key);
    // Always write `tags` literally (even "") once touched, rather than
    // deleting the param — see OrdersInitialParams.tagsProvided: an absent
    // `tags` key means "seed from activeOrderTags", so once the user has
    // made a choice we must keep emitting the key, even empty, so future
    // navigations don't silently fall back to the seeded default.
    updateParams({ tags: [...next].join(",") });
  }

  function clearFilters() {
    updateParams({
      status: null,
      area: null,
      payment: null,
      from: null,
      to: null,
      q: null,
      tags: "", // explicit empty — clears without re-seeding from active tags
    });
    setQInput("");
    setDateFromDraft("");
    setDateToDraft("");
    setFloristFilter(null);
  }

  function setSort(field: SortKey) {
    if (field === sort) updateParams({ dir: dir === "asc" ? "desc" : "asc" });
    else updateParams({ sort: field, dir: DEFAULT_DIR[field] });
  }

  // Free-text search — debounced ~300ms before it hits the URL (and thus the
  // server) so typing doesn't fire a fetch per keystroke.
  const [qInput, setQInput] = useState(initialParams.q);
  useEffect(() => setQInput(initialParams.q), [initialParams.q]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (qInput !== initialParams.q) updateParams({ q: qInput || null });
    }, 300);
    return () => clearTimeout(t);
  }, [qInput, initialParams.q, updateParams]);

  // Date range — staged locally, pushed to the URL on "Apply" (matches the
  // popover's existing Apply/Clear affordance).
  const [dateFromDraft, setDateFromDraft] = useState(initialParams.from);
  const [dateToDraft, setDateToDraft] = useState(initialParams.to);
  useEffect(() => setDateFromDraft(initialParams.from), [initialParams.from]);
  useEffect(() => setDateToDraft(initialParams.to), [initialParams.to]);

  // Florist filter is deliberately NOT a URL param: the florist name comes
  // from a joined to-many `order_assignments.florists` relation, and its
  // option list is already only the names on THIS page (see floristOptions
  // below) — so it can only ever narrow what's already fetched. It resets
  // whenever the fetched page changes since a prior choice may no longer
  // apply to the new result set.
  const [floristFilter, setFloristFilter] = useState<string | null>(null);
  useEffect(() => setFloristFilter(null), [orders]);

  // One primary chip (attention reason, else plain stage) plus any demoted
  // secondary chips (e.g. a payout hold that a higher-precedence reason like
  // escalation already outranked as primary) — see lib/orderVisual.ts.
  // `visual` still gets ALL assignments (candidates included) — the tone/
  // attention logic legitimately needs the full reach-out picture (e.g. "no
  // live offer" only makes sense knowing about sent/opened candidates).
  // `accepted` is narrower on purpose: only an accepted/delivered assignment
  // counts as "the" florist for display (see findAcceptedAssignment).
  const enriched = useMemo(
    () =>
      orders.map((o) => {
        const accepted = findAcceptedAssignment(o.order_assignments ?? []);
        const visual = toVisual(o);
        return {
          order: o,
          floristName: accepted?.florists?.name ?? null,
          payoutPrice: accepted?.payout_price ?? null,
          visual,
          primary: primaryChip(visual),
          secondary: secondaryChips(visual),
        };
      }),
    [orders]
  );

  const displayed = useMemo(
    () => (floristFilter ? enriched.filter((r) => r.floristName === floristFilter) : enriched),
    [enriched, floristFilter]
  );

  // Option lists reflect only the rows on THIS page (a full distinct-across-
  // all-orders query would defeat the point of paginating) — each popover
  // below carries a small caption saying so.
  const floristOptions = useMemo(
    () => Array.from(new Set(enriched.map((e) => e.floristName).filter((n): n is string => !!n))).sort(),
    [enriched]
  );
  const areaOptions = useMemo(
    () => Array.from(new Set(orders.map((o) => o.delivery_area).filter((a): a is string => !!a))).sort(),
    [orders]
  );
  const paymentOptions = useMemo(
    () => Array.from(new Set(orders.map((o) => o.financial_status).filter((p): p is string => !!p))).sort(),
    [orders]
  );
  const tagOptions = useMemo(
    () => Array.from(new Set(orders.flatMap((o) => splitOrderTags(o.tags)))).sort(),
    [orders]
  );

  const activeFilterCount =
    statusFilter.size +
    (floristFilter ? 1 : 0) +
    (initialParams.area ? 1 : 0) +
    (initialParams.payment ? 1 : 0) +
    (initialParams.from ? 1 : 0) +
    (initialParams.to ? 1 : 0) +
    (initialParams.q ? 1 : 0) +
    tagSelection.size;

  const start = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalCount);
  const isDefaultView = activeFilterCount === 0 && !showCompleted && !showFulfilled;

  // "Current state" tiles — Control-panel-style glance numbers, built entirely
  // from data this page already fetched (no extra queries). `totalCount` is
  // the one exact cross-page number (a server head-count); the rest are
  // explicitly THIS PAGE only, labelled as such so a staffer never mistakes
  // "3 on this page" for "3 total".
  const attentionOnPage = useMemo(() => enriched.filter((e) => e.primary.tone === "crit").length, [enriched]);

  return (
    <main className="ds page-wide">
      <p className="eyebrow">Backoffice</p>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <h1>{pageTitle("Orders")}</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }} title="Pull a real order from Shopify by its id or #name">
            <input
              value={pullId}
              onChange={(e) => { setPullId(e.target.value); setPullError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") pullOrder(); }}
              disabled={pullBusy}
              placeholder="Shopify order id / #name"
              aria-label="Shopify order id or name"
              aria-invalid={pullError ? true : undefined}
              style={{ ...selectStyle, minWidth: 180, borderColor: pullError ? "var(--crit)" : "var(--line-strong)" }}
            />
            <button type="button" onClick={pullOrder} disabled={pullBusy || !pullId.trim()}
              className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-ink-soft hover:text-ink disabled:opacity-50">
              {pullBusy ? "Pulling…" : "⬇ Pull from Shopify"}
            </button>
          </div>
          {canUseMockTool && (
            <select
              value={mockFloristId}
              onChange={(e) => setMockFloristId(e.target.value)}
              onFocus={loadMockFlorists}
              disabled={mockBusy !== null}
              aria-label="Florist for mock order"
              title="Pin a florist as the top candidate (defaults to random)"
              style={selectStyle}
            >
              <option value="">Random florist</option>
              {mockFlorists.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          )}
          {canUseMockTool && (
            <select
              value={mockDeadline}
              onChange={(e) => setMockDeadline(e.target.value)}
              disabled={mockBusy !== null}
              aria-label="Delivery deadline for mock order"
              title="Pin the delivery deadline to test a hand-over rule. Anything but the default also adds the order to the working set, so the wave engine works it."
              style={selectStyle}
            >
              <option value="">Delivery in 1–3 days</option>
              <option value="6">Urgent · in 6h — runs every candidate</option>
              <option value="4">Urgent · in 4h — runs every candidate</option>
              <option value="2.5">Urgent · in 2h 30 — hits the CX reserve</option>
              <option value="-1">Late · 1h ago — refused outright</option>
            </select>
          )}
          <button type="button" onClick={genMock} disabled={mockBusy !== null}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-ink disabled:opacity-50">
            {mockBusy === "gen" ? "Generating…" : "🧪 Generate mock order"}
          </button>
          <button type="button" onClick={clearMocks} disabled={mockBusy !== null}
            className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-ink-soft hover:text-ink disabled:opacity-50"
            title="Delete all mock orders">
            {mockBusy === "clear" ? "Clearing…" : "Clear mocks"}
          </button>
          {isAdmin && (
            <button type="button" onClick={reconcileNow} disabled={reconcileBusy}
              className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-ink-soft hover:text-ink disabled:opacity-50"
              title="Force the reconcile sweep now: backfill orders missed by webhook + re-check parked orders for late tags (normally runs hourly)">
              {reconcileBusy ? "Reconciling…" : "↻ Reconcile now"}
            </button>
          )}
          {isAdmin && (fullSweep?.mode ? (
            <button type="button" onClick={() => reconcileAll("stop")} disabled={allBusy !== null}
              className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-ink-soft hover:text-ink disabled:opacity-50"
              title="Stop the running full reconcile">
              ■ Stop full reconcile
            </button>
          ) : (
            <>
              <button type="button" onClick={() => reconcileAll("dry")} disabled={allBusy !== null}
                className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-ink-soft hover:text-ink disabled:opacity-50"
                title="Check EVERY order against Shopify and report what would change — writes nothing">
                {allBusy === "dry" ? "Arming…" : "⁇ Reconcile all (dry run)"}
              </button>
              <button type="button" onClick={() => reconcileAll("apply")} disabled={allBusy !== null}
                className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-ink-soft hover:text-ink disabled:opacity-50"
                title="Align EVERY order's status with Shopify — closes orders Shopify has fulfilled or archived">
                {allBusy === "apply" ? "Arming…" : "↻ Reconcile all"}
              </button>
            </>
          ))}
        </div>
      </div>

      <section className="mt-4">
        <p className="mini-h mb-3">Current state</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            label="Matching filters"
            value={totalCount}
            accent="slate"
            icon={<IconLayers className="h-4 w-4" />}
          />
          <StatTile
            label="This page"
            value={orders.length}
            accent="slate"
            icon={<IconLayers className="h-4 w-4" />}
          />
          <StatTile
            label="Needs attention · this page"
            value={attentionOnPage}
            accent={attentionOnPage > 0 ? "red" : "emerald"}
            icon={<IconAlertTriangle className="h-4 w-4" />}
          />
          <StatTile
            label="Working set"
            value={worklistCount}
            accent="emerald"
            icon={<IconLayers className="h-4 w-4" />}
          />
        </div>
      </section>

      {fullSweep && (fullSweep.mode || fullSweep.stats) && (
        <p role="status" style={{ marginTop: 10, color: "var(--ink-soft)", fontSize: ".85rem" }}>
          {fullSweep.mode === "dry" ? "Dry run in progress" : fullSweep.mode === "apply" ? "Full reconcile in progress" : "Last full reconcile"}
          {" — "}
          {fullSweep.stats?.swept ?? 0} swept
          {", "}{fullSweep.stats?.closed ?? 0} {fullSweep.mode === "dry" ? "would close" : "closed"}
          {(fullSweep.stats?.conflicts ?? 0) > 0 ? `, ${fullSweep.stats?.conflicts} conflict(s)` : ""}
          {(fullSweep.stats?.errors ?? 0) > 0 ? `, ${fullSweep.stats?.errors} error(s)` : ""}
          {fullSweep.stats?.finishedAt ? " · finished" : ""}
        </p>
      )}

      <div style={{ marginTop: 10 }}>
        <AddByNumber />
      </div>

      {initialParams.gateOff && (
        <p
          role="status"
          style={{
            marginTop: 10, padding: "8px 12px", borderRadius: 8,
            border: "1px solid var(--line-strong)", background: "var(--surface-2)",
            color: "var(--ink-soft)", fontSize: ".85rem",
          }}
        >
          Showing <strong style={{ color: "var(--ink)" }}>every</strong> order — the working-set filter is off for this view.
          {" "}
          <button
            type="button"
            onClick={() => updateParams({ gate: null, tags: null })}
            style={{
              background: "none", border: "none", padding: 0, cursor: "pointer",
              color: "var(--accent)", font: "inherit", textDecoration: "underline",
            }}
          >
            Back to the working set
          </button>
        </p>
      )}

      {(hiddenByGate > 0 || worklistCount > 0) && (
        <p
          role="status"
          style={{
            marginTop: 10, padding: "8px 12px", borderRadius: 8,
            border: "1px solid var(--line-strong)", background: "var(--surface-2)",
            color: "var(--ink-soft)", fontSize: ".85rem",
            display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
          }}
        >
          {worklistCount > 0 && (
            <button
              type="button"
              onClick={() =>
                updateParams(
                  initialParams.worklistOnly ? { worklist: null } : { worklist: "1", gate: null }
                )
              }
              title={
                initialParams.worklistOnly
                  ? "Back to the full working set (tags included)"
                  : "Show only the orders picked by number"
              }
              style={{
                border: "1px solid var(--line-strong)", borderRadius: 999, padding: "2px 10px",
                cursor: "pointer", font: "inherit", fontSize: ".82rem",
                background: initialParams.worklistOnly ? "var(--accent)" : "transparent",
                color: initialParams.worklistOnly ? "#fff" : "var(--ink)",
              }}
            >
              Working set: {worklistCount}
            </button>
          )}
          {hiddenByGate > 0 && (
            <span>
              <strong style={{ color: "var(--ink)" }}>{hiddenByGate}</strong>
              {hiddenByGate === 1 ? " order is" : " orders are"} hidden — not in the working set
              {appliedTags.length ? <> (tags: <code>{appliedTags.join(", ")}</code>)</> : null}.
              {" "}
              <button
                type="button"
                onClick={() => updateParams({ gate: "0", worklist: null })}
                style={{
                  background: "none", border: "none", padding: 0, cursor: "pointer",
                  color: "var(--accent)", font: "inherit", textDecoration: "underline",
                }}
              >
                Show them
              </button>
              {" — tick any row to add it, paste a list with “Add orders by number”, or change the tag default in Settings → Active order tags."}
            </span>
          )}
        </p>
      )}

      {(reconcileMsg || reconcileErr) && (
        <p role="status" style={{ marginTop: 10, color: reconcileErr ? "var(--crit)" : "var(--ink-soft)", fontSize: ".85rem" }}>
          {reconcileErr ?? reconcileMsg}
        </p>
      )}

      {pullError && (
        <p role="alert" style={{ marginTop: 10, color: "var(--crit)", fontSize: ".85rem" }}>
          {pullError}
        </p>
      )}

      {orders.length === 0 ? (
        <div style={{ marginTop: 24 }}>
          <EmptyState
            icon={<IconReceipt className="h-12 w-12 text-ink-faint" />}
            title={page > 1 ? "Nothing on this page" : isDefaultView ? "No orders yet" : "No orders match these filters"}
            description={
              page > 1
                ? "You've paged past the last matching order."
                : isDefaultView
                ? "Orders will show up here once they come in from Shopify."
                : "Try widening your filters, or clear them to see more orders."
            }
            action={
              page > 1 ? (
                <button type="button" className="btn btn-ghost" onClick={() => goToPage(1)}>Back to page 1</button>
              ) : activeFilterCount > 0 ? (
                <button type="button" className="btn btn-ghost" onClick={clearFilters}>Clear filters</button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <>
          <div className="filterbar" style={{ marginTop: 16, justifyContent: "space-between" }}>
            <div className="filterbar">
              <FilterPopover label="Status" count={statusFilter.size}>
                {() => (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {ORDER_STATUSES.map((s) => (
                      <label key={s} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: ".85rem", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={statusFilter.has(s)}
                          onChange={() => toggleStatus(s)}
                        />
                        {ORDER_STATUS_LABEL[s]}
                      </label>
                    ))}
                  </div>
                )}
              </FilterPopover>

              <button
                type="button"
                className={`filter-trigger${showCompleted ? " on" : ""}`}
                onClick={() => updateParams({ completed: showCompleted ? null : "1" })}
                title={showCompleted ? "Hide delivered/paid/closed/cancelled orders" : "Show delivered/paid/closed/cancelled orders too"}
              >
                {showCompleted ? "Hiding nothing" : "Hide completed"}
              </button>

              <button
                type="button"
                className={`filter-trigger${showFulfilled ? " on" : ""}`}
                onClick={() => updateParams({ fulfilled: showFulfilled ? null : "1" })}
                title={showFulfilled ? "Hide Shopify-fulfilled orders" : "Show Shopify-fulfilled orders too"}
              >
                {showFulfilled ? "Showing fulfilled" : "Show fulfilled"}
              </button>

              <FilterPopover label="Florist" count={floristFilter ? 1 : 0}>
                {(close) => (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 240, overflowY: "auto" }}>
                    <p style={{ color: "var(--ink-faint)", fontSize: ".72rem", margin: "0 0 4px" }}>Options reflect this page only</p>
                    <button type="button" className="btn btn-ghost" style={{ justifyContent: "flex-start", border: "none" }} onClick={() => { setFloristFilter(null); close(); }}>
                      All florists
                    </button>
                    {floristOptions.map((name) => (
                      <button
                        key={name}
                        type="button"
                        className="btn btn-ghost"
                        style={{ justifyContent: "flex-start", border: "none", fontWeight: floristFilter === name ? 700 : 400 }}
                        onClick={() => { setFloristFilter(name); close(); }}
                      >
                        {name}
                      </button>
                    ))}
                    {floristOptions.length === 0 && <p style={{ color: "var(--ink-faint)", fontSize: ".8rem" }}>No assigned florists on this page.</p>}
                  </div>
                )}
              </FilterPopover>

              <FilterPopover label="Area" count={initialParams.area ? 1 : 0}>
                {(close) => (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 240, overflowY: "auto" }}>
                    <p style={{ color: "var(--ink-faint)", fontSize: ".72rem", margin: "0 0 4px" }}>Options reflect this page only</p>
                    <button type="button" className="btn btn-ghost" style={{ justifyContent: "flex-start", border: "none" }} onClick={() => { updateParams({ area: null }); close(); }}>
                      All areas
                    </button>
                    {areaOptions.map((area) => (
                      <button
                        key={area}
                        type="button"
                        className="btn btn-ghost"
                        style={{ justifyContent: "flex-start", border: "none", fontWeight: initialParams.area === area ? 700 : 400 }}
                        onClick={() => { updateParams({ area }); close(); }}
                      >
                        {area}
                      </button>
                    ))}
                    {areaOptions.length === 0 && <p style={{ color: "var(--ink-faint)", fontSize: ".8rem" }}>No delivery areas on this page.</p>}
                  </div>
                )}
              </FilterPopover>

              <FilterPopover label="Date range" count={(initialParams.from ? 1 : 0) + (initialParams.to ? 1 : 0)}>
                {(close) => (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <label style={{ fontSize: ".78rem", color: "var(--ink-faint)", display: "flex", flexDirection: "column", gap: 4 }}>
                      From
                      <input type="date" value={dateFromDraft} onChange={(e) => setDateFromDraft(e.target.value)} style={dateInputStyle} />
                    </label>
                    <label style={{ fontSize: ".78rem", color: "var(--ink-faint)", display: "flex", flexDirection: "column", gap: 4 }}>
                      To
                      <input type="date" value={dateToDraft} onChange={(e) => setDateToDraft(e.target.value)} style={dateInputStyle} />
                    </label>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button type="button" className="btn btn-ghost" onClick={() => { setDateFromDraft(""); setDateToDraft(""); updateParams({ from: null, to: null }); }}>Clear</button>
                      <button type="button" className="btn btn-solid" onClick={() => { updateParams({ from: dateFromDraft || null, to: dateToDraft || null }); close(); }}>Apply</button>
                    </div>
                  </div>
                )}
              </FilterPopover>

              <FilterPopover label="Payment" count={initialParams.payment ? 1 : 0}>
                {(close) => (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 240, overflowY: "auto" }}>
                    <p style={{ color: "var(--ink-faint)", fontSize: ".72rem", margin: "0 0 4px" }}>Options reflect this page only</p>
                    <button type="button" className="btn btn-ghost" style={{ justifyContent: "flex-start", border: "none" }} onClick={() => { updateParams({ payment: null }); close(); }}>
                      All payment states
                    </button>
                    {paymentOptions.map((p) => (
                      <button
                        key={p}
                        type="button"
                        className="btn btn-ghost"
                        style={{ justifyContent: "flex-start", border: "none", fontWeight: initialParams.payment === p ? 700 : 400 }}
                        onClick={() => { updateParams({ payment: p }); close(); }}
                      >
                        {p}
                      </button>
                    ))}
                    {paymentOptions.length === 0 && <p style={{ color: "var(--ink-faint)", fontSize: ".8rem" }}>No payment data on this page.</p>}
                  </div>
                )}
              </FilterPopover>

              <FilterPopover label="Tags" count={tagSelection.size}>
                {() => (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 240, overflowY: "auto" }}>
                    <p style={{ color: "var(--ink-faint)", fontSize: ".72rem", margin: "0 0 4px" }}>Options reflect this page only</p>
                    {activeOrderTags.length > 0 && (
                      <p style={{ color: "var(--ink-faint)", fontSize: ".72rem", margin: "0 0 4px" }}>
                        Defaults to: {activeOrderTags.join(", ")}
                      </p>
                    )}
                    {tagOptions.map((tag) => {
                      const key = tag.trim().toLowerCase();
                      return (
                        <label key={tag} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: ".85rem", cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={tagSelection.has(key)}
                            onChange={() => toggleTag(tag)}
                          />
                          {tag}
                        </label>
                      );
                    })}
                    {tagOptions.length === 0 && <p style={{ color: "var(--ink-faint)", fontSize: ".8rem" }}>No order tags on this page.</p>}
                  </div>
                )}
              </FilterPopover>

              <div style={{ display: "flex", alignItems: "center" }}>
                <input
                  value={qInput}
                  onChange={(e) => setQInput(e.target.value)}
                  placeholder="Search order / recipient / email"
                  aria-label="Search orders"
                  style={{ ...selectStyle, minWidth: 220, fontWeight: 400 }}
                />
              </div>

              {activeFilterCount > 0 && (
                <button type="button" className="btn btn-ghost" onClick={clearFilters}>
                  Clear filters
                </button>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label className="mini-h" htmlFor="orders-sort">Sort</label>
              <select
                id="orders-sort"
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                style={selectStyle}
                title="Order total is still the server sort key even though the Payout column shows florist payout"
              >
                <option value="created">Created</option>
                <option value="deliver">Deliver</option>
                <option value="total">Order total</option>
                <option value="status">Status</option>
              </select>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => updateParams({ dir: dir === "asc" ? "desc" : "asc" })}
                aria-label={dir === "asc" ? "Sort ascending" : "Sort descending"}
              >
                {dir === "asc" ? "↑" : "↓"}
              </button>
            </div>
          </div>

          {selected.size > 0 && (
            <div className="card" style={{ marginTop: 12, borderColor: confirmingBulkDelete ? "var(--crit)" : "var(--line-strong)", background: confirmingBulkDelete ? "color-mix(in srgb, var(--crit) 8%, transparent)" : "var(--surface-2)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: ".85rem", fontWeight: 600, color: "var(--ink)" }}>{selected.size} selected</span>

              {/* Working set — what the system actually operates on. Any staff
                  member can drive this; only the delete below is admin-only. */}
              {!confirmingBulkDelete && (
                <>
                  <button
                    type="button"
                    className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-ink disabled:opacity-50"
                    disabled={worklistBusy !== null}
                    title="Match, work, and show these orders by default — union'd with the tags in Settings"
                    onClick={() => setWorklist(false)}
                  >
                    {worklistBusy === "add" ? "Adding…" : "＋ Add to working set"}
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-ink-soft hover:text-ink disabled:opacity-50"
                    disabled={worklistBusy !== null}
                    title="Stop showing these by default. Work already in flight is untouched."
                    onClick={() => setWorklist(true)}
                  >
                    {worklistBusy === "remove" ? "Removing…" : "− Remove from working set"}
                  </button>
                  {worklistError && <span style={{ color: "var(--crit)", fontSize: ".82rem" }}>{worklistError}</span>}
                </>
              )}

              {isAdmin && confirmingBulkDelete ? (
                <>
                  <span style={{ fontSize: ".82rem", color: "var(--ink-soft)" }}>Delete {selected.size} order{selected.size > 1 ? "s" : ""}? (soft — restorable from each order page)</span>
                  <button type="button" className="rounded-md bg-crit px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50" disabled={bulkDeleteBusy} onClick={bulkDelete}>
                    {bulkDeleteBusy ? "Deleting…" : "Confirm delete"}
                  </button>
                  <button type="button" className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-ink-soft hover:text-ink disabled:opacity-50" disabled={bulkDeleteBusy} onClick={() => setConfirmingBulkDelete(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  {isAdmin && (
                    <button type="button" className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-ink-soft hover:text-ink" onClick={() => setConfirmingBulkDelete(true)}>
                      Delete selected
                    </button>
                  )}
                  <button type="button" className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-ink-soft hover:text-ink" onClick={() => setSelected(new Set())}>
                    Clear selection
                  </button>
                </>
              )}
              {bulkDeleteError && <span style={{ color: "var(--crit)", fontSize: ".82rem" }}>{bulkDeleteError}</span>}
            </div>
          )}

          <div className="card" style={{ padding: 0, overflow: "hidden", marginTop: 12 }}>
            {displayed.length === 0 && ready ? (
              <div style={{ padding: 8 }}>
                <EmptyState
                  icon={<IconReceipt className="h-12 w-12 text-ink-faint" />}
                  title="No orders match these filters"
                  description="Try widening your filters, or clear them to see all orders."
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
                    <th>
                      {/* All staff — row selection drives the working-set
                          actions, not just admin bulk delete. */}
                      <input
                        type="checkbox"
                        aria-label="Select all visible orders"
                        title="Select all visible orders"
                        checked={displayed.length > 0 && displayed.every(({ order: o }) => selected.has(o.id))}
                        onChange={(e) => {
                          setSelected(e.target.checked ? new Set(displayed.map(({ order: o }) => o.id)) : new Set());
                        }}
                      />
                    </th>
                    <th>Order</th>
                    <th>Status</th>
                    <th>Destination</th>
                    <th>Deadline</th>
                    <th>Florist</th>
                    <th style={{ textAlign: "right" }} title="What we're willing to pay the florist for this order — not the buyer's order total, and not necessarily paid out yet">Offered payout</th>
                  </tr>
                </thead>
                <tbody>
                  {!ready ? (
                    <SkeletonRows />
                  ) : (
                    displayed.map(({ order: o, floristName, payoutPrice, visual, primary, secondary }) => (
                      <tr key={o.id} className={toneRowClass(orderTone(visual))} onClick={() => { location.href = `/orders/${o.id}`; }}>
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`Select order ${o.order_name ?? o.id.slice(0, 8)}`}
                            checked={selected.has(o.id)}
                            onChange={() => toggleSelected(o.id)}
                          />
                          {o.worklist_at && (
                            <span
                              title="In the working set — picked explicitly"
                              aria-label="In the working set"
                              style={{ marginLeft: 4, color: "var(--accent)", fontSize: ".8rem" }}
                            >
                              ●
                            </span>
                          )}
                        </td>
                        <td>
                          <Link href={`/orders/${o.id}`} style={{ fontWeight: 700, fontFamily: "var(--mono)" }}>
                            {o.order_name ?? o.id.slice(0, 8)}
                          </Link>
                        </td>
                        {/* One primary indicator (attention reason when one fires,
                            else the plain stage) with any demoted secondary notes
                            (e.g. a payout hold a higher-priority reason outranked)
                            shown quietly underneath — see lib/orderVisual.ts. */}
                        <td>
                          <span title={primary.label}>
                            <Badge info={{ cls: toneBadgeClass(primary.tone), label: primary.label }} />
                          </span>
                          {secondary.length > 0 && (
                            <div style={{ marginTop: 3, display: "flex", flexWrap: "wrap", gap: 6 }}>
                              {secondary.map((chip) => (
                                <span
                                  key={chip.label}
                                  title={chip.label}
                                  style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: ".72rem", color: "var(--ink-soft)" }}
                                >
                                  <IconCreditCard style={{ width: 12, height: 12 }} aria-hidden="true" />
                                  {chip.label}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td style={{ color: "var(--ink-soft)" }}>
                          {[deriveCity(o), deriveCountry(o)].filter((p) => p && p !== "—").join(", ") || "—"}
                        </td>
                        <td>
                          {(() => {
                            const severity = deliverySeverity(o.status, o.delivery_at);
                            const label = deliveryDeadlineLabel(o.status, o.delivery_at);
                            const color = severity === "crit" ? "var(--crit)" : severity === "warn" ? "var(--warn)" : "var(--ink-soft)";
                            return <span style={{ color, fontWeight: severity ? 700 : 400 }}>{label}</span>;
                          })()}
                        </td>
                        <td style={{ color: floristName ? "var(--ink)" : "var(--ink-soft)" }}>{floristDisplay(o.status, floristName)}</td>
                        <td style={{ textAlign: "right", fontWeight: 600, color: payoutPrice != null ? "var(--ink)" : "var(--ink-soft)" }}>
                          {payoutPrice != null ? formatMoney(payoutPrice, o.currency) : "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}
          </div>

          {totalCount > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, flexWrap: "wrap", gap: 8 }}>
              <span style={{ fontSize: ".82rem", color: "var(--ink-soft)" }}>
                Showing {start}–{end} of {totalCount}
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="btn btn-ghost" disabled={page <= 1} onClick={() => goToPage(page - 1)}>
                  Prev
                </button>
                <button type="button" className="btn btn-ghost" disabled={page * pageSize >= totalCount} onClick={() => goToPage(page + 1)}>
                  Next
                </button>
              </div>
            </div>
          )}
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
  color: "var(--ink)",
};

const dateInputStyle: React.CSSProperties = {
  font: ".8rem var(--sans)",
  padding: "5px 8px",
  borderRadius: 6,
  border: "1px solid var(--line-strong)",
  background: "var(--surface)",
  color: "var(--ink)",
};
