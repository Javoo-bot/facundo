import { createServerClient } from "@/lib/supabase";
import { getSessionUser, getStaffAccess } from "@/lib/authCache";
import SignInScreen from "@/components/SignInScreen";
import OrdersClient, { type OrderRow, type OrdersInitialParams } from "@/components/orders/OrdersClient";
import { ORDER_STATUSES, type OrderStatus } from "@/lib/orderStatus";
import { workingSetConfig, workingSetOrClause } from "@/lib/workingSetServer";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

type SortKey = "created" | "deliver" | "total" | "status";

// DB column each sort key maps to. "created" sorts by Shopify's own created
// timestamp (not our ingest `created_at`) so it matches what staff mean by
// "newest order" even if ingest lagged.
const SORT_COLUMN: Record<SortKey, string> = {
  created: "shopify_created_at",
  deliver: "delivery_at",
  total: "total",
  status: "status",
};

const TERMINAL_COMPLETED = ["paid", "closed", "cancelled", "delivered"] as const;

// Exactly the columns the table renders (see OrdersClient) plus the two the
// filters need. Previously this was `select("*")`, which dragged `raw` — the
// entire Shopify order payload, ~13 KB per row — through PostgREST and then
// through the RSC flight payload to the browser, for 50 rows a page. Measured
// on the real database: 571 KB and 211 ms a page, against 23 KB and 68 ms for
// this list. Nothing in the dashboard reads `orders.raw`.
const LIST_COLUMNS =
  "id, order_name, shopify_created_at, created_at, delivery_at, delivery_window, delivery_area, delivery_address, " +
  "recipient_name, total, currency, financial_status, fulfillment_status, status, tags, worklist_at";

// payout_price/payout_percent added so the list can show florist payout (see
// OrdersClient's Payout column) rather than the buyer-facing order total.
const ASSIGNMENT_EMBED = "order_assignments(status, florist_id, rank, payout_price, payout_percent, florists(name))";

/** Strip everything but word chars, whitespace, and a few safe punctuation
 * marks before interpolating a value into a PostgREST `.or()`/`.ilike()`
 * filter string. Those filters are raw comma/paren-delimited text (not
 * parameterized like `.eq()`/`.gte()`), so an unescaped `,`, `(`, `)`, `%`,
 * or `*` from user input could break the clause or widen the match in ways
 * the user didn't intend. */
function sanitizeForFilter(v: string): string {
  return v.replace(/[^\w\s.@#-]/g, "").trim();
}

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

interface ParsedParams {
  page: number;
  sort: SortKey;
  dir: "asc" | "desc";
  statuses: OrderStatus[];
  includeCompleted: boolean;
  includeFulfilled: boolean;
  /** Whether `tags` was present in the URL at all — distinguishes "user
   * cleared it to empty" from "param absent, seed from active tags". */
  tagsProvided: boolean;
  tagList: string[];
  /** `worklist=1` — show ONLY the explicitly picked orders (the "Working set:
   * N" chip). Narrower than the working set itself, which also admits tags. */
  worklistOnly: boolean;
  /** `gate=0` — ignore the working set entirely for this view (the "Show them"
   * link on the hidden-orders banner). Clearing `tags` alone is NOT enough:
   * with explicit picks present, empty tags means "only the picks", which
   * would show FEWER orders than before, not more. */
  gateOff: boolean;
  q: string;
  area: string;
  payment: string;
  from: string;
  to: string;
}

function parseSearchParams(sp: Record<string, string | string[] | undefined>): ParsedParams {
  const get = (k: string) => firstParam(sp[k]);

  const pageNum = parseInt(get("page") ?? "1", 10);
  const page = Number.isFinite(pageNum) && pageNum > 0 ? pageNum : 1;

  const sortRaw = get("sort");
  const sort: SortKey = sortRaw === "deliver" || sortRaw === "total" || sortRaw === "status" ? sortRaw : "created";
  const dir: "asc" | "desc" = get("dir") === "asc" ? "asc" : "desc";

  const statusRaw = get("status");
  const statuses: OrderStatus[] = statusRaw
    ? statusRaw
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is OrderStatus => (ORDER_STATUSES as string[]).includes(s))
    : [];

  const includeCompleted = get("completed") === "1";
  const includeFulfilled = get("fulfilled") === "1";

  const tagsRaw = get("tags");
  const tagsProvided = tagsRaw !== undefined;
  const tagList = tagsProvided
    ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean)
    : [];

  return {
    page,
    sort,
    dir,
    statuses,
    includeCompleted,
    includeFulfilled,
    tagsProvided,
    tagList,
    worklistOnly: get("worklist") === "1",
    gateOff: get("gate") === "0",
    q: get("q") ?? "",
    area: get("area") ?? "",
    payment: get("payment") ?? "",
    from: get("from") ?? "",
    to: get("to") ?? "",
  };
}

// Every filter EXCEPT the working-set gate, applied identically to the three
// queries below (the page query, the out-of-range count fallback, and the
// "how much is the gate hiding" count). It used to be copy-pasted three times,
// which is how a filter could silently apply to the list but not to the count
// that tells you what the list is hiding.
function applyBaseFilters<T>(query: T, parsed: ParsedParams, qSanitized: string): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST's builder is generic over the row type; each filter returns a differently-typed builder, so this walks it untyped and restores T on return.
  let q = query as any;
  if (parsed.statuses.length) {
    // An explicit status filter overrides the completed/fulfilled defaults —
    // the user asked for exactly these statuses.
    q = q.in("status", parsed.statuses);
  } else {
    if (!parsed.includeCompleted) q = q.not("status", "in", `(${TERMINAL_COMPLETED.join(",")})`);
    // Explicit working-set picks must remain visible in the control panel until
    // a final/terminal state clears them. Shopify can mark an order fulfilled
    // before our local lifecycle reaches terminal, so don't hide fulfilled rows
    // from the working-set view unless staff asked for a specific status.
    if (!parsed.includeFulfilled && !parsed.worklistOnly) q = q.or("fulfillment_status.is.null,fulfillment_status.neq.fulfilled");
  }
  if (parsed.worklistOnly) q = q.not("worklist_at", "is", null);
  if (parsed.area) q = q.eq("delivery_area", parsed.area);
  if (parsed.payment) q = q.eq("financial_status", parsed.payment);
  if (parsed.from) q = q.gte("delivery_at", `${parsed.from}T00:00:00`);
  if (parsed.to) q = q.lte("delivery_at", `${parsed.to}T23:59:59`);
  if (qSanitized) {
    q = q.or(
      `order_name.ilike.*${qSanitized}*,buyer_name.ilike.*${qSanitized}*,buyer_email.ilike.*${qSanitized}*`
    );
  }
  return q as T;
}

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getSessionUser();
  if (!user) return <SignInScreen />;
  const { allowed, role } = await getStaffAccess(user.email);
  const supabase = await createServerClient();
  if (!allowed) {
    await supabase.auth.signOut();
    return <SignInScreen error="unauthorized" />;
  }
  const isAdmin = role === "admin";
  // Who can drive the mock-order tool — mirrors its API gate
  // (app/api/dev/mock-order requireRole("ops","admin")). The florist picker it
  // needs is no longer fetched here: it was a 1,189-row roster pulled on EVERY
  // orders-list render to feed a tool most renders never open. It now loads on
  // demand from /api/florists/options when the tool is actually opened.
  const canUseMockTool = role === "admin" || role === "ops";

  const parsed = parseSearchParams(await searchParams);

  // The working set — tags UNION explicitly picked orders. Off only when both
  // are empty (see lib/workingSet.ts for why). One settings read plus one
  // indexed head-count, in parallel.
  const [settingsRow, wsConfig] = await Promise.all([
    supabase.from("app_settings").select("reconcile_all_mode, reconcile_all_stats").eq("id", 1).maybeSingle(),
    workingSetConfig(supabase),
  ]);
  const activeOrderTags = wsConfig.activeTags;

  // Contract (unchanged): `tags` absent from the URL ⇒ seed from the staff-
  // configured active set. `tags` present (even as an empty string) ⇒ use it
  // literally, so the user can deliberately clear it. Existing bookmarks keep
  // working.
  const tagList = parsed.tagsProvided ? parsed.tagList : activeOrderTags;

  // What the user is actually filtering by right now. When they've overridden
  // the tags in the URL, the explicit-picks half of the gate still applies —
  // clearing tags shouldn't silently drop the orders someone hand-picked.
  const viewConfig = {
    activeTags: tagList,
    activeCountries: wsConfig.activeCountries,
    runAllOrders: wsConfig.runAllOrders,
    anyExplicitPicks: wsConfig.anyExplicitPicks,
  };
  // `worklistOnly` already narrows to the picks via applyBaseFilters, and
  // `gateOff` deliberately shows everything — neither wants the gate clause.
  const gateClause =
    parsed.worklistOnly || parsed.gateOff ? null : workingSetOrClause(viewConfig, sanitizeForFilter);
  const sanitizedTags = tagList.map(sanitizeForFilter).filter(Boolean);

  // Nested select pulls the current-candidate florist name in one round trip
  // (RLS-safe — session client, `authenticated` policies on both orders and
  // order_assignments/florists). OrdersClient derives the "leading" assignment
  // (accepted, else lowest-rank still-active candidate) per row.
  const qSanitized = sanitizeForFilter(parsed.q);
  let query = applyBaseFilters(
    supabase
      .from("orders")
      .select(`${LIST_COLUMNS}, ${ASSIGNMENT_EMBED}`, { count: "exact" })
      .is("deleted_at", null),
    parsed,
    qSanitized
  );
  if (gateClause) query = query.or(gateClause);

  const col = SORT_COLUMN[parsed.sort];
  query = query.order(col, { ascending: parsed.dir === "asc", nullsFirst: false });
  query = query.range((parsed.page - 1) * PAGE_SIZE, parsed.page * PAGE_SIZE - 1);

  const { data: rawOrders, count: rawCount, error: rawError } = await query;

  let orders = rawOrders;
  let count = rawCount;
  let error = rawError;

  // A `page` beyond the last page for the current filters (stale bookmark,
  // hand-edited URL, or filters that shrank between tabs) makes PostgREST
  // 416 ("Requested range not satisfiable", code PGRST103) instead of
  // returning zero rows — confirmed against the real DB while verifying this
  // change. Re-run count-only with the same WHERE clauses (no range, so it
  // can't itself go out of range) so the pagination footer still reports the
  // real total, and treat this page as simply empty — OrdersClient's
  // "Nothing on this page → back to page 1" empty state handles the rest —
  // rather than surfacing it as a hard load failure.
  if (error?.code === "PGRST103") {
    let countQuery = applyBaseFilters(
      supabase.from("orders").select("id", { count: "exact", head: true }).is("deleted_at", null),
      parsed,
      qSanitized
    );
    if (gateClause) countQuery = countQuery.or(gateClause);
    const { count: fallbackCount, error: fallbackError } = await countQuery;
    orders = [];
    count = fallbackCount ?? 0;
    error = fallbackError ?? null;
  }

  if (error) return <div className="ds page">Failed to load orders: {error.message}</div>;

  // Which of THIS PAGE's orders have money still held/failed — so a delivered
  // order whose payout is stuck stays visible (attention) instead of being
  // hidden as "completed". Scoped to this page's order ids only (the old
  // all-payouts scan doesn't make sense once orders are paginated): this
  // page's assignments → held/failed payouts on those assignments → order ids.
  const pageOrderIds = (orders ?? []).map((o) => o.id);
  const { data: pageAssignments } = pageOrderIds.length
    ? await supabase.from("order_assignments").select("id, order_id").in("order_id", pageOrderIds)
    : { data: [] as { id: string; order_id: string }[] };
  const pageAsgIds = (pageAssignments ?? []).map((a) => a.id);
  const { data: heldPayouts } = pageAsgIds.length
    ? await supabase.from("payouts").select("assignment_id").in("status", ["held", "failed"]).in("assignment_id", pageAsgIds)
    : { data: [] as { assignment_id: string }[] };
  const heldAsgIds = new Set((heldPayouts ?? []).map((p) => p.assignment_id).filter(Boolean));
  const heldOrderIds = new Set(
    (pageAssignments ?? []).filter((a) => heldAsgIds.has(a.id)).map((a) => a.order_id)
  );

  // `as unknown as OrderRow[]` at the call site below, for the same reason as
  // app/(staff)/florists/page.tsx: supabase-js types a to-one embed
  // (`florists(name)`) as an ARRAY, though PostgREST returns a single object
  // for it at runtime. The old `select("*")` returned `any` and hid this; the
  // narrowed column list types the row properly, which is what surfaced it.
  const enriched = (orders ?? []).map((o) => ({ ...o, moneyHeld: heldOrderIds.has(o.id) }));

  // How many orders the WORKING-SET GATE alone is holding back. Without this the
  // page is indistinguishable from "there is no work": on 2026-08-04 every one
  // of the 337 open orders was hidden because the active set was still
  // `local-florist` while the store had moved to `fulfill …` tags, and the list
  // simply rendered empty. Same WHERE clauses as the real query minus the gate,
  // count-only (head: true), and skipped entirely when the gate is off.
  let hiddenByGate = 0;
  if (gateClause) {
    const { count: withoutGate } = await applyBaseFilters(
      supabase.from("orders").select("id", { count: "exact", head: true }).is("deleted_at", null),
      parsed,
      qSanitized
    );
    hiddenByGate = Math.max(0, (withoutGate ?? 0) - (count ?? 0));
  }

  // Size of the explicit half of the working set — the "Working set: N" chip.
  const { count: worklistCount } = wsConfig.anyExplicitPicks
    ? await supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .not("worklist_at", "is", null)
        .is("deleted_at", null)
    : { count: 0 };

  const initialParams: OrdersInitialParams = {
    sort: parsed.sort,
    dir: parsed.dir,
    status: parsed.statuses,
    completed: parsed.includeCompleted,
    fulfilled: parsed.includeFulfilled,
    tags: tagList,
    tagsProvided: parsed.tagsProvided,
    worklistOnly: parsed.worklistOnly,
    gateOff: parsed.gateOff,
    q: parsed.q,
    area: parsed.area,
    payment: parsed.payment,
    from: parsed.from,
    to: parsed.to,
  };

  return (
    <OrdersClient
      orders={enriched as unknown as OrderRow[]}
      totalCount={count ?? 0}
      page={parsed.page}
      pageSize={PAGE_SIZE}
      canUseMockTool={canUseMockTool}
      isAdmin={isAdmin}
      activeOrderTags={activeOrderTags}
      hiddenByGate={hiddenByGate}
      appliedTags={sanitizedTags}
      worklistCount={worklistCount ?? 0}
      fullSweep={{
        mode: (settingsRow.data?.reconcile_all_mode as string | null) ?? null,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsonb stats blob written by the worker
        stats: (settingsRow.data?.reconcile_all_stats as any) ?? null,
      }}
      initialParams={initialParams}
    />
  );
}
