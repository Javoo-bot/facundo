// Pure pre-issue funds guard: is there enough available Airwallex wallet balance
// in the payout currency to fund this card?
//
// Fail-open on the CHECK: if the balance for the currency is unknown (missing
// entry / null available), we DON'T block — a monitoring gap must not stop a
// real payout. Fail-closed only on a known-insufficient balance.
//
// Structural balance type (no import) keeps this a leaf module for unit tests.

export interface FundBalance {
  currency: string;
  available_amount?: number | null;
}

export interface FundsResult {
  ok: boolean;
  available: number | null; // null = unknown (fail-open)
}

export function hasSufficientFunds(
  balances: FundBalance[] | null | undefined,
  currency: string,
  amountCents: number,
): FundsResult {
  const need = Math.round(amountCents) / 100;
  const cur = (currency ?? "").toUpperCase();
  const match = (balances ?? []).find((b) => (b.currency ?? "").toUpperCase() === cur);
  const available = match?.available_amount ?? null;
  if (available == null) return { ok: true, available: null }; // unknown → don't block
  return { ok: available >= need, available };
}
