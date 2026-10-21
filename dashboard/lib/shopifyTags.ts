// Pure helpers for the Shopify writeback, extracted so they unit-test under
// plain `node --test` without pulling in shopifyWriteback.ts's runtime
// imports (monitor / supabaseAdmin / externalOps, which aren't type-strippable
// — those files use extensionless specifiers plain `node --test` can't
// resolve, unlike webpack/Next's bundler resolution).

// Given Shopify's raw (possibly null/empty) comma-separated `tags` string,
// return the union with `tag` added — deduped case-insensitively, existing tags
// kept in their original order and casing.
export function unionTags(existingTagsCsv: string | null | undefined, tag: string): string {
  const existing = (existingTagsCsv ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  if (!existing.some((t) => t.toLowerCase() === tag.toLowerCase())) existing.push(tag);
  return existing.join(", ");
}

// Value format for the real "Tookan Cost Of Order" Shopify metafield
// (custom.tookan_cost_of_order, single_line_text_field) — confirmed against
// live production values on 2026-08-21 (e.g. "31.80", "41.70"): a bare
// 2-decimal number, NO currency suffix. No currency param — matching what's
// actually there beats guessing a format nothing downstream expects.
//
// Rounds to cents before formatting rather than a bare `.toFixed(2)`: the
// input is a sum of two already cent-scale legs (see sumPayoutLegs in
// lib/payoutMath.ts), and summing two IEEE-754 doubles can land a hair off a
// whole cent — `.toFixed(2)` alone can then round the wrong way at an exact
// x.xx5 boundary. Same epsilon idiom as lib/payoutMath.ts's floorCents/floorPayout.
export function formatPayoutTotal(amount: number): string {
  const cents = Math.round(amount * 100 + 1e-6);
  return (cents / 100).toFixed(2);
}
