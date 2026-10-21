import type { useT } from "@/components/florist/LocaleProvider";
// Relative, not "@/lib/geo": plain `node --test` has no tsconfig-alias
// resolution, and an aliased runtime import here would make this whole module
// (and so orderFormat.test.mjs) unimportable — the exact reason
// scripts/tests.mjs has to exclude lib/apiAuth.test.mjs. geo.ts is a leaf
// module with no imports of its own, so this costs nothing. The `useT` import
// above is fine aliased: `import type` is erased before it is ever resolved.
import { formatKm } from "../../lib/geo.ts";

// Formatting shared by the offer view (components/florist/offer/) and the
// post-accept work order (components/florist/FloristOrderDetail.tsx). Lifted
// out of FloristOrderDetail when the offer state moved to its own component
// tree, so the two states cannot drift into showing the same order's distance
// or delivery time in two different shapes.

export function euro(n: number | null): string {
  return n != null ? `€${n.toFixed(2)}` : "—";
}

/** Non-nullable wrapper over lib/geo's formatKm — the offer/work-order views
 *  only reach here with a distance in hand. One rule, one implementation, so
 *  the florist and staff sides cannot round a distance differently. */
export function fmtKm(km: number): string {
  return formatKm(km) ?? "—";
}

/** Compact deliver-by: "Today 18:00" / "Tomorrow 09:00" / "Mon 14 · 18:00".
 * `t` is passed in (rather than called via useT() here) because this is a
 * module-level helper, not a component — reuses the same
 * ui.offer.inbox.today / ui.offer.inbox.tomorrow keys as FloristInbox.tsx. */
export function fmtDeliverBy(
  iso: string | null | undefined,
  t: ReturnType<typeof useT>["t"]
): { day: string; time: string } {
  if (!iso) return { day: "—", time: "" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { day: "—", time: "" };
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const day =
    d.toDateString() === now.toDateString()
      ? t("ui.offer.inbox.today")
      : d.toDateString() === tomorrow.toDateString()
        ? t("ui.offer.inbox.tomorrow")
        : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  return { day, time };
}

/** A stored `orders.recipient_phone` reduced to something that can be pasted
 * straight into a dialler, or null when the value isn't confidently a single
 * number — in which case the work order shows no phone control at all, rather
 * than handing the florist a number that reaches the wrong person.
 *
 * This is what the copy button puts on the clipboard. The number the florist
 * READS is the stored string unchanged; only the copied value is normalised, so
 * a paste never carries brackets or spaces into a phone app.
 *
 * Calibrated against every order we have ingested (6,782 rows, 2026-09-14): the
 * only non-digit characters that occur are "+" (3,244 rows), "(" and ")" (4
 * rows) and space (3 rows); 6 to 15 digits; no nulls, no letters, no
 * extensions, no "/"-separated double entries. So stripping to digits plus a
 * LEADING "+" is exact for the real data, not a guess.
 *
 * Two deliberate rules for what the data doesn't (yet) contain:
 *  - The leading "+" is KEPT. Roughly half of these are stored in international
 *    form, and a cross-border delivery is normal here; dropping the "+" would
 *    produce a different number rather than fail visibly.
 *  - A SECOND "+" returns null instead of mashing two numbers into one
 *    plausible-looking string. Zero rows do this today; if one ever does, a
 *    florist falls back to the order chat, which is strictly better than
 *    handing them a number that rings a stranger. */
export function dialableNumber(phone: unknown): string | null {
  if (typeof phone !== "string") return null;
  const dialable = phone.replace(/[^\d+]/g, "");
  if (dialable.includes("+", 1)) return null;
  return /\d/.test(dialable) ? dialable : null;
}

// components/addons come from Shopify as a comma-joined list of referenced
// product titles — split for a scannable chip list instead of one run-on line.
export function splitList(s: string | null): string[] {
  return s ? s.split(",").map((v) => v.trim()).filter(Boolean) : [];
}
