// Pure builder for a card's `authorization_controls`. Kept separate from the IO
// in cards.ts so the control shape (single-use, spend limit, currency, optional
// MCC allow-list) is unit-testable.

export interface CardControlOpts {
  amountCents: number;
  currency: string;
  // Merchant Category Codes to allow (e.g. floral/gift). Empty/undefined =>
  // no MCC restriction. Narrowing this bounds where a payout card can be spent.
  mccAllowlist?: string[];
}

// Cents -> major units, rounded to 2 dp (never a floating-point tail like 26.599999).
export function centsToMajor(cents: number): number {
  return Math.round(cents) / 100;
}

// Comma/space-separated env value -> a clean MCC list (digits kept, blanks dropped).
export function parseMccAllowlist(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function buildAuthorizationControls(opts: CardControlOpts): Record<string, unknown> {
  const controls: Record<string, unknown> = {
    // single-use — one successful transaction only
    allowed_transaction_count: "SINGLE",
    transaction_limits: {
      currency: opts.currency,
      limits: [{ interval: "ALL_TIME", amount: centsToMajor(opts.amountCents) }],
    },
  };
  if (opts.mccAllowlist && opts.mccAllowlist.length > 0) {
    controls.allowed_merchant_categories = opts.mccAllowlist;
  }
  return controls;
}
