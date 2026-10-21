// Words and dates for the two operator screens. Pure, and every function
// guards null rather than emitting "Invalid Date" or "NaN" (repo convention).

/** "Mon 17 Aug 12:25", in the viewer's locale. */
export function shortStamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleString([], {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

/** "Friday 21 August" */
export function longDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

/**
 * "Deliver Friday 21 August · in 2 days" / "· 9 days overdue".
 *
 * `now` is a parameter so this is pure and testable; callers pass Date.now().
 */
export function dueLabel(iso: string | null | undefined, now: number): { text: string; overdue: boolean } | null {
  const day = longDay(iso);
  if (!day || !iso) return null;
  const t = new Date(iso).getTime();
  const days = Math.round((t - now) / 86_400_000);
  if (days < 0) {
    const n = Math.abs(days);
    return { text: `Deliver ${day} · ${n} ${n === 1 ? "day" : "days"} overdue`, overdue: true };
  }
  const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  return { text: `Deliver ${day} · ${when}`, overdue: days <= 1 };
}

/** "York YO1 8AS, United Kingdom" from the stored address JSON, tolerating
 *  the key variants the ingest worker and the mock tooling each write. */
export function destinationLine(
  address: Record<string, unknown> | null | undefined,
  fallbackArea: string | null | undefined,
): string {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  if (address && typeof address === "object") {
    const a = address as Record<string, unknown>;
    const city = str(a.city);
    const postal = str(a.postal) ?? str(a.zip) ?? str(a.postal_code);
    const country = str(a.country) ?? str(a.country_code);
    const parts = [[city, postal].filter(Boolean).join(" "), country].filter(Boolean);
    if (parts.length) return parts.join(", ");
  }
  return str(fallbackArea) ?? "Destination unknown";
}

/** "5.0★ 432 Google reviews · 4.7 km from the delivery address" — only the
 *  parts we actually hold, so a shop with no rating doesn't read as 0 stars. */
export function shopFacts(
  rating: number | null,
  reviewCount: number | null,
  distanceLabel: string | null,
): string | null {
  const bits: string[] = [];
  if (rating != null && Number.isFinite(rating)) {
    const stars = `${rating.toFixed(1)}★`;
    bits.push(reviewCount != null ? `${stars} ${reviewCount.toLocaleString()} Google reviews` : stars);
  }
  if (distanceLabel) bits.push(`${distanceLabel} from the delivery address`);
  return bits.length ? bits.join(" · ") : null;
}

/** Who to ask for when the phone is answered. */
export function whoToAskFor(ownerName: string | null): string {
  return ownerName
    ? `Ask for ${ownerName}.`
    : "No contact name on file — ask who handles the orders.";
}
