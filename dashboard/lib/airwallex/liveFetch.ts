// The one `fetchLive` builder every bulkLiveCheck caller uses — factored out
// so app/api/payouts/live-status/route.ts's POST and the reconcile route
// fan out to Airwallex identically and can never disagree about what counts
// as a "partial" answer (a card read that got some but not all of
// card/authorizations/transactions).

import { getCard, getCardAuthorizations, getCardTransactions } from "./cards.ts";

export type FetchLive = (cardId: string) => Promise<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Airwallex JSON is untyped
  card: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Airwallex JSON is untyped
  authorizations: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Airwallex JSON is untyped
  transactions: any[];
  partial: string[];
}>;

/** One round trip each, in parallel — allSettled so a single failing endpoint
 *  still yields a useful partial answer instead of losing the whole card. */
export const bulkFetchLive: FetchLive = async (cardId: string) => {
  const [card, auths, txns] = await Promise.allSettled([
    getCard(cardId),
    getCardAuthorizations(cardId),
    getCardTransactions(cardId),
  ]);

  const partial = [
    card.status === "rejected" ? "card" : null,
    auths.status === "rejected" ? "authorizations" : null,
    txns.status === "rejected" ? "transactions" : null,
  ].filter((x): x is string => x !== null);

  if (card.status === "rejected" && auths.status === "rejected" && txns.status === "rejected") {
    throw new Error("Could not reach Airwallex right now.");
  }

  return {
    card: card.status === "fulfilled" ? card.value : null,
    authorizations: auths.status === "fulfilled" ? auths.value?.items ?? [] : [],
    transactions: txns.status === "fulfilled" ? txns.value?.items ?? [] : [],
    partial,
  };
};
