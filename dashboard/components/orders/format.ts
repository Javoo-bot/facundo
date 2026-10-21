// Nullable-honest formatting helpers shared by the Orders list + detail
// screens — every function guards null/invalid input and returns "—" rather
// than NaN/"Invalid Date" (repo convention, see CLAUDE.md).

export function parseDateMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

export function formatMoney(amount: number | null | undefined, currency: string | null | undefined): string {
  if (amount == null || Number.isNaN(amount)) return "—";
  return currency ? `${amount.toFixed(2)} ${currency}` : amount.toFixed(2);
}

export function formatDateTime(iso: string | null | undefined): string {
  const t = parseDateMs(iso);
  return t == null ? "—" : new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/** Like formatDateTime but without the year — for dense tables where the
 * column is tight and every row is within the current season anyway (the
 * Control panel's order table). Deliberately a separate function rather than a
 * flag on formatDateTime, so the Orders list/detail keep the unambiguous
 * year-bearing form. */
export function formatDateTimeNoYear(iso: string | null | undefined): string {
  const t = parseDateMs(iso);
  if (t == null) return "—";
  return new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatTime(iso: string | null | undefined): string {
  const t = parseDateMs(iso);
  return t == null ? "—" : new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Coarse relative time ("12m ago", "3h from now") — good enough for a
 * timeline/audit trail, not meant to be second-accurate. */
export function formatRelative(iso: string | null | undefined): string {
  const t = parseDateMs(iso);
  if (t == null) return "—";
  const diffMs = Date.now() - t;
  const mins = Math.round(Math.abs(diffMs) / 60000);
  const suffix = diffMs >= 0 ? "ago" : "from now";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ${suffix}`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ${suffix}`;
  const days = Math.round(hrs / 24);
  return `${days}d ${suffix}`;
}
