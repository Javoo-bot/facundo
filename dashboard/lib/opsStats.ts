import type { SupabaseClient } from "@supabase/supabase-js";
import type { VisualFunnelStats } from "./visualFunnel.ts";
import { todayIso } from "./dateRange.ts";

// ---- All 7 query functions below call a `security definer` Postgres
// function (supabase/migrations/2026-08-05-ops-stats-functions.sql) via
// `.rpc()` instead of `select()`ing raw rows and counting/grouping them here.
// PostgREST caps a plain `select` at 1000 rows by default, so every count,
// group-by breakdown, and distribution derived from more than 1000 rows in
// range was silently wrong (e.g. "Orders, last 30d" showed 1000 when the
// real count was ~4000) — moving the aggregation into SQL means no metric
// depends on how many rows PostgREST would hand back. Each RPC function
// re-checks is_email_allowed() itself (it bypasses RLS by design, and
// EXECUTE is granted to `authenticated`, which florist sessions are too).
//
// EVERY failure here throws. It used to log and return an all-zeroes
// EMPTY_*_STATS, which meant an ops lead read a backend outage as "we had zero
// orders" — a fabricated number presented as fact, which is exactly what
// CLAUDE.md's "never fabricate a value; store null and be honest when unknown"
// rule forbids. It also made the failure path unreachable: supabase-js `.rpc()`
// resolves with `{ data: null, error }` instead of rejecting, so the
// `.catch(() => null)` -> <SectionUnavailable /> branch in
// app/(staff)/statistics/page.tsx never fired — not even for the "migration not
// applied yet" case it was written for. Throwing is what engages it. The
// resilience contract is unchanged and still lives in page.tsx: each getXStats()
// is awaited in its own Promise.all slot with its own `.catch(() => null)`, so
// one section going dark degrades that section and nothing else.

/** Thrown when a stats RPC fails. Carries the function name so the server log
 * says which section went dark, not just "rpc failed". */
export class StatsQueryError extends Error {
  // Assigned in the body, not as a `public readonly rpc` parameter property:
  // the test runner loads these .ts files through Node's strip-only type
  // stripping, which rejects parameter properties outright
  // (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  readonly rpc: string;

  constructor(rpc: string, detail: string) {
    super(`${rpc} failed: ${detail}`);
    this.name = "StatsQueryError";
    this.rpc = rpc;
  }
}

/** Inclusive ISO-date range (`YYYY-MM-DD`) — both `from` and `to` are counted
 * in full. The SQL side upholds this with `< (p_to + 1)::timestamptz`; see the
 * header of supabase/migrations/2026-08-05-ops-stats-functions.sql.
 *
 * The days are MADRID days. Those casts resolve against the TimeZone GUC, which
 * every get_*_stats function now pins to Europe/Madrid (see
 * supabase/migrations/2026-09-04-stats-ranges-in-madrid.sql — it also records
 * what the UTC reading used to cost: 3.5% of production orders sat on the wrong
 * calendar day). lib/dateRange.ts::todayIso is pinned to the same zone so the
 * range the client asks for and the range the database answers cannot drift.
 *
 * Shared by every stats query in this module and by lib/statsChat.ts's system
 * prompt examples. */
export interface StatsRange {
  from: string;
  to: string;
}

// Lives here (not in the client-only DateRangePicker component) so both the
// "/statistics" server components (which need a default StatsRange before any
// URL params exist) and the client DateRangePicker can import the same
// function. Next.js treats every export of a "use client" file as a
// client-boundary reference — calling one directly from a Server Component
// throws at runtime ("Attempted to call ... from the server but ... is on the
// client"), so this couldn't live in DateRangePicker.tsx even though it does no
// browser-only work.
//
// The default is TODAY (2026-09-04, the owner's call): the question these pages
// are opened with is "how did we do", and the honest answer to that is about a
// day, not about a rolling month that quietly averages a bad morning away. Any
// other window — a single past date or a span — is picked explicitly and lands
// in the URL, so a link always means one fixed thing.
//
// The day is the MADRID day, resolved the same way on every machine — the
// Cloudflare Worker rendering this in UTC and the browser reading it in Spain
// agree, and so does the database (see StatsRange above). That symmetry is the
// whole point: an asymmetric "today" made the page report on a day that had
// barely started for the first two hours of every working morning.
export function defaultRange(): StatsRange {
  const today = todayIso();
  return { from: today, to: today };
}

// ---- pure bucketing helpers ------------------------------------------------
// No longer used by the query functions below (the equivalent grouping now
// happens in SQL, see the RPC functions each getXStats() calls). Kept
// exported: opsStats.test.mjs exercises them directly as pure functions, and
// they're a reasonable client-side utility for any future small, already-
// capped row set.

export function bucketOrdersByStatus(rows: { status: string | null }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (!r.status) continue;
    out[r.status] = (out[r.status] ?? 0) + 1;
  }
  return out;
}

export function bucketDeclineReasons(rows: { decline_reason: string | null }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (!r.decline_reason) continue;
    out[r.decline_reason] = (out[r.decline_reason] ?? 0) + 1;
  }
  return out;
}

// ---- query functions --------------------------------------------------

export interface OrdersStats {
  totalOrders: number;
  byStatus: Record<string, number>;
  byDay: { date: string; count: number }[];
}

export async function getOrdersStats(db: SupabaseClient, range: StatsRange): Promise<OrdersStats> {
  const { data, error } = await db.rpc("get_orders_stats", { p_from: range.from, p_to: range.to });
  if (error) throw new StatsQueryError("get_orders_stats", error.message);
  if (!data) throw new StatsQueryError("get_orders_stats", "returned no payload");
  return {
    totalOrders: Number(data.totalOrders ?? 0),
    byStatus: (data.byStatus ?? {}) as Record<string, number>,
    byDay: (data.byDay ?? []) as { date: string; count: number }[],
  };
}

export interface AcceptanceStats {
  totalAssignments: number;
  acceptedCount: number;
  acceptRate: number | null; // null when totalAssignments is 0
  declineReasons: Record<string, number>;   // pre-accept declines
  releaseReasons: Record<string, number>;   // post-accept releases (status='released')
}

export async function getAcceptanceStats(db: SupabaseClient, range: StatsRange): Promise<AcceptanceStats> {
  const { data, error } = await db.rpc("get_acceptance_stats", { p_from: range.from, p_to: range.to });
  if (error) throw new StatsQueryError("get_acceptance_stats", error.message);
  if (!data) throw new StatsQueryError("get_acceptance_stats", "returned no payload");
  return {
    totalAssignments: Number(data.totalAssignments ?? 0),
    acceptedCount: Number(data.acceptedCount ?? 0),
    acceptRate: data.acceptRate == null ? null : Number(data.acceptRate),
    declineReasons: (data.declineReasons ?? {}) as Record<string, number>,
    releaseReasons: (data.releaseReasons ?? {}) as Record<string, number>,
  };
}

/** 8 fixed 6-hour buckets, 0-48h, last bucket catches the rest — computed in
 * SQL now (see get_fulfilment_stats) instead of client-side over a raw
 * per-assignment array, which would itself be unbounded at scale. */
export interface FulfilmentStats {
  acceptedCount: number;
  deliveredCount: number;
  completionRate: number | null; // deliveredCount / acceptedCount, null if acceptedCount is 0
  onTimeCount: number;
  onTimeRate: number | null; // out of deliveredCount with a non-null sla_deadline_at
  timeToDeliveryHistogram: { bucket: string; count: number }[];
}

const EMPTY_FULFILMENT_HISTOGRAM: { bucket: string; count: number }[] = Array.from({ length: 8 }, (_, i) => ({
  bucket: `${i * 6}-${(i + 1) * 6}h`,
  count: 0,
}));

export async function getFulfilmentStats(db: SupabaseClient, range: StatsRange): Promise<FulfilmentStats> {
  const { data, error } = await db.rpc("get_fulfilment_stats", { p_from: range.from, p_to: range.to });
  if (error) throw new StatsQueryError("get_fulfilment_stats", error.message);
  if (!data) throw new StatsQueryError("get_fulfilment_stats", "returned no payload");
  return {
    acceptedCount: Number(data.acceptedCount ?? 0),
    deliveredCount: Number(data.deliveredCount ?? 0),
    completionRate: data.completionRate == null ? null : Number(data.completionRate),
    onTimeCount: Number(data.onTimeCount ?? 0),
    onTimeRate: data.onTimeRate == null ? null : Number(data.onTimeRate),
    timeToDeliveryHistogram: (data.timeToDeliveryHistogram ?? EMPTY_FULFILMENT_HISTOGRAM) as { bucket: string; count: number }[],
  };
}

export function bucketIssuesByType(rows: { type: string | null }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (!r.type) continue;
    out[r.type] = (out[r.type] ?? 0) + 1;
  }
  return out;
}

/** resolutionTimeHours (one entry per resolved issue) is replaced with a
 * single median, computed in SQL (get_issues_stats) — the raw per-issue
 * array would be another unbounded-to-the-browser list, and IssuesSection.tsx
 * doesn't chart the distribution today (only the counts and byType). */
export interface IssuesStats {
  totalIssues: number;
  openCount: number;
  resolvedCount: number;
  byType: Record<string, number>;
  resolutionTimeHoursMedian: number | null;
}

export async function getIssuesStats(db: SupabaseClient, range: StatsRange): Promise<IssuesStats> {
  const { data, error } = await db.rpc("get_issues_stats", { p_from: range.from, p_to: range.to });
  if (error) throw new StatsQueryError("get_issues_stats", error.message);
  if (!data) throw new StatsQueryError("get_issues_stats", "returned no payload");
  return {
    totalIssues: Number(data.totalIssues ?? 0),
    openCount: Number(data.openCount ?? 0),
    resolvedCount: Number(data.resolvedCount ?? 0),
    byType: (data.byType ?? {}) as Record<string, number>,
    resolutionTimeHoursMedian: data.resolutionTimeHoursMedian == null ? null : Number(data.resolutionTimeHoursMedian),
  };
}

export function bucketByDay<T>(rows: T[], getTimestamp: (row: T) => string): { date: string; count: number }[] {
  const map = new Map<string, number>();
  for (const r of rows) {
    const day = getTimestamp(r).slice(0, 10);
    map.set(day, (map.get(day) ?? 0) + 1);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));
}

export interface UsageStats {
  activeFloristsByDay: { date: string; count: number }[]; // distinct florist_id per day, from login_events
  medianResponseMinutes: number | null; // median(accepted_at/declined_at - sent_at) across order_assignments in range
}

export async function getUsageStats(db: SupabaseClient, range: StatsRange): Promise<UsageStats> {
  const { data, error } = await db.rpc("get_usage_stats", { p_from: range.from, p_to: range.to });
  if (error) throw new StatsQueryError("get_usage_stats", error.message);
  if (!data) throw new StatsQueryError("get_usage_stats", "returned no payload");
  return {
    activeFloristsByDay: (data.activeFloristsByDay ?? []) as { date: string; count: number }[],
    medianResponseMinutes: data.medianResponseMinutes == null ? null : Number(data.medianResponseMinutes),
  };
}

export interface LoginStats {
  staffLoginsByDay: { date: string; count: number }[];
  floristLoginsByDay: { date: string; count: number }[];
}

export async function getLoginStats(db: SupabaseClient, range: StatsRange): Promise<LoginStats> {
  const { data, error } = await db.rpc("get_login_stats", { p_from: range.from, p_to: range.to });
  if (error) throw new StatsQueryError("get_login_stats", error.message);
  if (!data) throw new StatsQueryError("get_login_stats", "returned no payload");
  return {
    staffLoginsByDay: (data.staffLoginsByDay ?? []) as { date: string; count: number }[],
    floristLoginsByDay: (data.floristLoginsByDay ?? []) as { date: string; count: number }[],
  };
}

export interface EmailStats {
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
}

export interface SmsStats {
  sent: number;
  delivered: number;
  failed: number;
  /** Short-link hits. There is no carrier-level "opened" for SMS. */
  clicked: number;
}

export interface PushStats {
  sent: number;
  failed: number;
}

/** All three florist-facing channels, for the Messaging section. */
export interface MessagingStats {
  email: EmailStats;
  sms: SmsStats;
  push: PushStats;
}

/**
 * One round trip for all three channels (see get_messaging_stats).
 *
 * The email half is the SAME function `getEmailStats` calls, composed
 * server-side rather than re-derived, so the two can never disagree.
 */
export async function getMessagingStats(db: SupabaseClient, range: StatsRange): Promise<MessagingStats> {
  const { data, error } = await db.rpc("get_messaging_stats", { p_from: range.from, p_to: range.to });
  if (error) throw new StatsQueryError("get_messaging_stats", error.message);
  if (!data) throw new StatsQueryError("get_messaging_stats", "returned no payload");
  const e = data.email ?? {};
  const s = data.sms ?? {};
  const p = data.push ?? {};
  return {
    email: {
      sent: Number(e.sent ?? 0),
      delivered: Number(e.delivered ?? 0),
      opened: Number(e.opened ?? 0),
      clicked: Number(e.clicked ?? 0),
      bounced: Number(e.bounced ?? 0),
      complained: Number(e.complained ?? 0),
    },
    sms: {
      sent: Number(s.sent ?? 0),
      delivered: Number(s.delivered ?? 0),
      failed: Number(s.failed ?? 0),
      clicked: Number(s.clicked ?? 0),
    },
    push: { sent: Number(p.sent ?? 0), failed: Number(p.failed ?? 0) },
  };
}

export async function getEmailStats(db: SupabaseClient, range: StatsRange): Promise<EmailStats> {
  const { data, error } = await db.rpc("get_email_stats", { p_from: range.from, p_to: range.to });
  if (error) throw new StatsQueryError("get_email_stats", error.message);
  if (!data) throw new StatsQueryError("get_email_stats", "returned no payload");
  return {
    sent: Number(data.sent ?? 0),
    delivered: Number(data.delivered ?? 0),
    opened: Number(data.opened ?? 0),
    clicked: Number(data.clicked ?? 0),
    bounced: Number(data.bounced ?? 0),
    complained: Number(data.complained ?? 0),
  };
}

/** One funnel step's numbers, per channel.
 *
 * `clicked` is the RAW email_events count and deliberately includes clicks the
 * funnel refused to act on — a link scanner's click is stored but never moves
 * an enrolment (lib/sequences/clickQuality.ts). Reporting the raw number is the
 * point: if most "clicks" on a step are machines, that is the most useful thing
 * this page can say, and filtering them out would make the step look effective. */
export interface FunnelStepStats {
  step: string;
  channel: string;
  sent: number;
  skipped: number;
  failed: number;
  delivered: number;
  clicked: number;
  bounced: number;
}

/** How runs stand, and how they ended. `exhausted` is the NORMAL end of a
 * funnel — the prospect saw every touch and passes to long-term nurture — not a
 * failure, and the UI says so. */
export interface FunnelEnrolmentStats {
  sequence_id: string;
  status: string;
  stop_reason: string;
  n: number;
  engaged: number;
}

export interface FunnelStats {
  steps: FunnelStepStats[];
  enrolments: FunnelEnrolmentStats[];
}

export async function getFunnelStats(db: SupabaseClient, range: StatsRange): Promise<FunnelStats> {
  const { data, error } = await db.rpc("get_funnel_stats", { p_from: range.from, p_to: range.to });
  if (error) throw new StatsQueryError("get_funnel_stats", error.message);
  if (!data) throw new StatsQueryError("get_funnel_stats", "returned no payload");
  const num = (v: unknown) => Number(v ?? 0);
  return {
    steps: ((data.steps ?? []) as Record<string, unknown>[]).map((s) => ({
      step: String(s.step ?? ""),
      channel: String(s.channel ?? ""),
      sent: num(s.sent),
      skipped: num(s.skipped),
      failed: num(s.failed),
      delivered: num(s.delivered),
      clicked: num(s.clicked),
      bounced: num(s.bounced),
    })),
    enrolments: ((data.enrolments ?? []) as Record<string, unknown>[]).map((e) => ({
      sequence_id: String(e.sequence_id ?? ""),
      status: String(e.status ?? ""),
      stop_reason: String(e.stop_reason ?? ""),
      n: num(e.n),
      engaged: num(e.engaged),
    })),
  };
}

/**
 * The shop-level recruiting funnel behind /statistics/funnel.
 *
 * Separate from getFunnelStats above, which counts TOUCHES ("which angle earns
 * the click"). This one counts SHOPS through nested stages, which is the only
 * shape that can answer "where are we losing florists". The stage arithmetic
 * lives in lib/visualFunnel.ts; this function only fetches and coerces.
 *
 * Coerces every field through Number(v ?? 0) like its siblings, but note what
 * that does NOT mean: an outright RPC failure still throws, so page.tsx renders
 * "unavailable" rather than a funnel of zeroes. The zero default here only
 * covers a key the SQL genuinely returned as null.
 */
/**
 * The days the date picker is allowed to offer — every calendar day we have
 * orders for (supabase/migrations/2026-09-04-stats-active-days.sql). Orders are
 * the clock for EVERY statistics view, funnel included; that migration's header
 * says why, and it is not obvious.
 *
 * Unlike its siblings this one does NOT throw on failure: it degrades to `null`
 * at the call site, and a `null` list means "offer every past day". The failure
 * has to open the picker rather than close it — a stats page whose calendar is
 * entirely unclickable because one RPC is missing (a deploy where this
 * migration hasn't been applied yet) would be unusable, while an over-generous
 * calendar merely lets someone land on an empty day and read the empty state.
 */
export async function getStatsActiveDays(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db.rpc("get_stats_active_days");
  if (error) throw new StatsQueryError("get_stats_active_days", error.message);
  if (!Array.isArray(data)) throw new StatsQueryError("get_stats_active_days", "returned no payload");
  return (data as unknown[]).map(String);
}

export async function getVisualFunnelStats(db: SupabaseClient, range: StatsRange): Promise<VisualFunnelStats> {
  const { data, error } = await db.rpc("get_visual_funnel_stats", { p_from: range.from, p_to: range.to });
  if (error) throw new StatsQueryError("get_visual_funnel_stats", error.message);
  if (!data) throw new StatsQueryError("get_visual_funnel_stats", "returned no payload");
  const d = data as Record<string, unknown>;
  const num = (v: unknown) => Number(v ?? 0);
  return {
    picked: num(d.picked),
    messaged: num(d.messaged),
    delivered: num(d.delivered),
    seen: num(d.seen),
    clicked: num(d.clicked),
    joined: num(d.joined),
    never_messaged: num(d.never_messaged),
    skipped_only: num(d.skipped_only),
    bounced: num(d.bounced),
    opted_out: num(d.opted_out),
    no_feedback: num(d.no_feedback),
    clicked_raw: num(d.clicked_raw),
    still_running: num(d.still_running),
  };
}
