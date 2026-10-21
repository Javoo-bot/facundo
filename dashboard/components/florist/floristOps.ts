// Fulfillment-side formatting + derivation helpers for the florist detail
// page. Small pure functions duplicated here rather than imported from
// components/orders/** or components/payments/** — that's out of scope for
// this lane (see the "Do NOT touch" list in the build brief) and mirrors the
// existing codebase convention of colocating these near the screen that uses
// them rather than cross-importing an owned-by-someone-else directory (see
// components/payments/PaymentsLedger.tsx's own formatMoney/formatMoneySum,
// and components/florists/FloristsDirectory.tsx's own tierBadgeCls).
import type { Payout } from "@/lib/types";

export function formatMoney(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount == null || Number.isNaN(amount)) return "—";
  return currency ? `${amount.toFixed(2)} ${currency}` : amount.toFixed(2);
}

// Buckets by currency rather than summing raw numbers across currencies —
// `payouts.currency` is free-text/nullable, so nothing guarantees one
// currency per florist. A null currency gets its own unlabeled bucket.
export function formatMoneySum(entries: { amount: number | null; currency: string | null }[]): string {
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

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleDateString([], { dateStyle: "medium" });
}

// 1 best -> 4 worst, mirrors components/florists/FloristsDirectory.tsx's
// local tierBadgeCls (same "out of scope to import" reasoning as above).
export function tierBadgeCls(code: "1" | "2" | "3" | "4" | null | undefined): string {
  switch (code) {
    case "1": return "badge-accent";
    case "2": return "badge-amber";
    case "3": return "badge-neutral";
    case "4": return "badge-crit";
    default: return "badge-neutral";
  }
}

export function payoutStatusBadgeCls(status: Payout["status"]): string {
  switch (status) {
    case "paid":
    case "issued":
      return "badge-accent";
    case "failed":
      return "badge-crit";
    case "clawed_back":
      return "badge-warn";
    case "pending":
    default:
      return "badge-neutral";
  }
}

const LEG_LABEL: Record<Payout["leg"], string> = {
  accept: "On accept",
  delivery: "On delivery",
  manual: "Manual",
};
export function legLabel(leg: Payout["leg"]): string {
  return LEG_LABEL[leg] ?? leg;
}

const CHANNEL_LABEL: Record<string, string> = {
  email: "Email",
  whatsapp: "WhatsApp",
  app: "App",
};
export function channelLabel(channel: string | null | undefined): string {
  return channel ? (CHANNEL_LABEL[channel] ?? channel) : "—";
}

// `business_hours` is a free-form jsonb map (e.g. {"mon_fri":"09:00-20:00",
// "sat":"09:00-15:00"} — see supabase/seed/2026-07-13-florist-demo.sql).
// No fixed schema is enforced, so this just relabels whatever day-token keys
// are present ("mon_fri" -> "Mon–Fri") rather than fabricating a full week.
function dayLabel(token: string): string {
  return token
    .split("_")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join("–");
}

export function businessHoursLabel(hours: Record<string, unknown> | null | undefined): string {
  if (!hours) return "—";
  const entries = Object.entries(hours).filter(([, v]) => typeof v === "string" && v.length > 0);
  if (entries.length === 0) return "—";
  return entries.map(([day, range]) => `${dayLabel(day)} ${range}`).join(" · ");
}

export interface AssignmentLike {
  id: string;
  status: string;
  delivered_at: string | null;
  payout_price: number | null;
  orders: { status: string } | null;
}

export interface PerformanceStats {
  assigned: number;
  accepted: number;
  delivered: number;
  declined: number;
  acceptanceRateLabel: string;
}

/** Orders-assigned / accepted / delivered / declined counts + acceptance
 * rate, derived from this florist's order_assignments. Guards the /0 case
 * (no accepted or declined assignments yet) rather than producing NaN. */
export function computePerformance(assignments: AssignmentLike[]): PerformanceStats {
  const accepted = assignments.filter((a) => a.status === "accepted" || a.status === "delivered").length;
  const delivered = assignments.filter(
    (a) => a.delivered_at != null || a.orders?.status === "delivered"
  ).length;
  const declined = assignments.filter((a) => a.status === "declined").length;
  const denom = accepted + declined;
  const acceptanceRateLabel = denom === 0 ? "—" : `${Math.round((accepted / denom) * 100)}%`;
  return { assigned: assignments.length, accepted, delivered, declined, acceptanceRateLabel };
}

// --- Sprint 4 (feedback loop): florist_stats view row + tier-review hint ------

/** Row shape of the `florist_stats` SQL view (supabase/migrations/
 * 2026-07-15-florist-stats.sql) — all-time acceptance/on-time rates + counts.
 * Rates are null (not 0/NaN) when there's no data yet (sample_size 0). */
export interface FloristStatsRow {
  florist_id: string;
  acceptance_rate: number | null;
  on_time_rate: number | null;
  decline_count: number;
  issue_count: number;
  sample_size: number;
}

export function pctLabel(rate: number | null | undefined): string {
  if (rate == null || Number.isNaN(rate)) return "—";
  return `${Math.round(rate * 100)}%`;
}

/** Recent-window (last 10 assignments, newest first) inputs for the
 * tier-review recommendation hint. `recentIssueCount` is computed by the
 * caller (server page) as delivery_events(type='problem') restricted to the
 * assignment ids inside that same window — see florist_stats migration's
 * comment for why this is computed here rather than windowed in the view. */
export function tierReviewRecommended(
  recentAssignments: Pick<AssignmentLike, "status">[],
  recentIssueCount: number,
  windowSize = 10
): boolean {
  const recent = recentAssignments.slice(0, windowSize);
  const declineCount = recent.filter((a) => a.status === "declined").length;
  return declineCount >= 3 || recentIssueCount >= 1;
}
