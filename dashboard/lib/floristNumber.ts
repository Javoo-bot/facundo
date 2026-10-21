// Facundo-minted "Florist ID" — a 7-digit integer WE generate per florist
// that doesn't already have one (via the assign_florist_number() DB function,
// see supabase/migrations/2026-08-21-florist-number.sql). A florist with a
// real known id has it entered by hand instead. Written back to Shopify as
// "Tookan Florist Id" (custom.tookan_florist_id, confirmed live 2026-08-21)
// — NOT "Odoo Florist Order Id", which real data shows is order-scoped, not
// florist-scoped. See the mapping comment in lib/shopifyWriteback.ts; nothing
// outside that file should use the Shopify name.

// ============================================================================
// RESERVED BLOCK — a considered default, not confirmed against a real range
// ============================================================================
// 9000000 was chosen against the numeric spaces actually observed live on
// 2026-08-21 (Odoo order ids ~1.5 million; Odoo supplier ids up to
// 76276006/300445, with 999999999 looking like a placeholder). The real
// target field, custom.tookan_florist_id, was checked across 66 sampled real
// orders and was unpopulated on every one — there's no live value to confirm
// this range against, only the field's existence. Re-check if Tookan is ever
// revived and starts writing real values here.
//
// MIRRORS `florist_number_seq`'s `start with` value in
// supabase/migrations/2026-08-21-florist-number.sql — the two must move
// together; this constant is not read by the sequence, it's for the TS side
// (e.g. validating/labeling a value as "in the Facundo-minted range").
// ============================================================================
export const FLORIST_NUMBER_RESERVED_START = 9000000;

/** Is this florist_number in the Facundo-minted reserved range (as opposed
 * to a legacy value from some other range)? */
export function isReservedFloristNumber(n: number): boolean {
  return Number.isInteger(n) && n >= FLORIST_NUMBER_RESERVED_START;
}
