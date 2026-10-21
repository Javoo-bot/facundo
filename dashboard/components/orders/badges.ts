// Badge-class helpers for the Orders screens that don't already have a
// badgeMap.ts entry (trust tier, payout leg status, order payment status).

export function tierBadgeCls(code: "1" | "2" | "3" | "4" | null | undefined): string {
  switch (code) {
    case "1": return "badge-accent";
    case "2": return "badge-amber";
    case "3": return "badge-neutral";
    case "4": return "badge-crit";
    default: return "badge-neutral";
  }
}

export function payoutStatusBadgeCls(status: string): string {
  switch (status) {
    case "paid": return "badge-accent";
    case "issued": return "badge-warn";
    case "held": return "badge-warn";
    case "failed": return "badge-crit";
    case "clawed_back": return "badge-crit";
    case "pending":
    default:
      return "badge-neutral";
  }
}

export function verdictBadgeCls(verdict: "pass" | "review" | "fail"): string {
  switch (verdict) {
    case "pass": return "badge-accent";
    case "review": return "badge-warn";
    case "fail": return "badge-crit";
    default: return "badge-neutral";
  }
}

export function paymentStatusBadgeCls(status: string | null | undefined): string {
  if (!status) return "badge-neutral";
  const s = status.toLowerCase();
  if (s === "paid") return "badge-accent";
  if (s === "pending" || s === "authorized") return "badge-warn";
  if (s === "refunded" || s === "partially_refunded" || s === "voided") return "badge-crit";
  return "badge-neutral";
}
