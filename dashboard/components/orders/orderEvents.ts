import { ORDER_STATUS_LABEL, isOrderStatus } from "@/lib/orderStatus";

// Static labels for order_events.type values that aren't dynamically shaped.
// See app/api/orders/{reachout,status,resolve-escalation,reassign,shopify-conflict}/route.ts,
// app/api/florist/{respond,photo,release}/route.ts and lib/{payout,clientComms,waves}.ts
// for the full set of types this needs to cover.
const STATIC_LABELS: Record<string, string> = {
  outreach_sent: "Outreach sent to florist",
  shopify_conflict: "Shopify conflict — order closed elsewhere while we still held it",
  shopify_conflict_resolved: "Shopify conflict resolved",
  order_assigned: "Florist accepted the order",
  declined: "Candidate declined",
  offer_resent: "Offer re-sent to the same florist",
  escalated: "Order escalated",
  shopify_writeback: "Shopify status updated",
  escalation_resolved: "Escalation resolved",
  reassigned: "Reassigned to next candidate",
  client_comm: "Client notified",
  payout_clawback: "Payout clawed back",
  rematched: "Candidates regenerated",
  florist_added: "Florist added manually",
  substitution_approved: "Substitution approved",
  issue_resolved: "Issue resolved",
  released_by_florist: "Florist gave the order back",
  accept_sla_breach: "Handed on — florist went quiet",
  deleted: "Order deleted (admin)",
  restored: "Order restored (admin)",
  match_skipped: "Matching skipped — no active tag",
};

// Human labels for the structured order_issues types (raised via issue:<type>).
const ISSUE_LABELS: Record<string, string> = {
  missing_ingredient: "missing ingredient",
  wrong_address: "wrong address",
  out_of_range: "address out of range",
  recipient_unavailable: "no one home",
  damaged_wrong_recipient: "damaged / wrong recipient",
  other: "other",
};

/** Maps a raw `order_events.type` to a human label. Falls back to the raw
 * type string for anything unrecognized rather than fabricating a label. */
export function eventLabel(type: string): string {
  if (type.startsWith("status:")) {
    const to = type.slice("status:".length);
    return isOrderStatus(to) ? `Status → ${ORDER_STATUS_LABEL[to]}` : `Status → ${to}`;
  }
  if (type.endsWith("_photo")) {
    const kind = type.slice(0, -"_photo".length);
    return kind ? `${kind.charAt(0).toUpperCase()}${kind.slice(1)} photo uploaded` : "Photo uploaded";
  }
  if (type.startsWith("payout_") && type !== "payout_clawback") {
    return `Payout issued — ${type.slice("payout_".length)}`;
  }
  if (type.startsWith("issue:")) {
    const kind = type.slice("issue:".length);
    return `Issue reported — ${ISSUE_LABELS[kind] ?? kind}`;
  }
  return STATIC_LABELS[type] ?? type;
}
