// Deep-links from the FLQ dashboard into the Airwallex web console.
//
// Paths verified against the live sandbox console (2026-07-14):
//   - a card:               /app/cards/card-details/{card_id}   (bare path works)
//   - the card-txn list:    /app/cards/transactions
// Issuing has no stable per-transaction or per-dispute console URL — those open
// in-page from the transactions list — so a disputed row links to that list.
//
// The console host differs between sandbox (demo.airwallex.com) and production
// (www.airwallex.com); derived from AIRWALLEX_BASE (the API host) unless
// AIRWALLEX_APP_BASE is set. Read at call time so tests/env changes take effect.

const DEMO_MARKERS = ["api-demo.airwallex.com", "demo.airwallex.com"];

export function isDemoAirwallexBase(base = process.env.AIRWALLEX_BASE || "https://api-demo.airwallex.com"): boolean {
  return DEMO_MARKERS.some((m) => base.includes(m));
}

function appBase(): string {
  const explicit = process.env.AIRWALLEX_APP_BASE;
  if (explicit) return explicit.replace(/\/+$/, "");
  const isDemo = isDemoAirwallexBase();
  return isDemo ? "https://demo.airwallex.com" : "https://www.airwallex.com";
}

// Console page for a single issued card. Null when there's no card_id (e.g. a
// ledger-rail payout).
export function airwallexCardUrl(cardId: string | null | undefined): string | null {
  if (!cardId) return null;
  return `${appBase()}/app/cards/card-details/${encodeURIComponent(cardId)}`;
}

// The card-transactions list — where a card's spend and any transaction dispute
// is surfaced (no per-transaction deep-link exists).
export function airwallexCardTransactionsUrl(): string {
  return `${appBase()}/app/cards/transactions`;
}
