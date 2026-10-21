// Airwallex wallet balances — the funding source for issued cards. Used by the
// pre-issue funds guard (payout.ts) and the staff Payments page.
// NOTE: confirm the exact path/fields against the sandbox when Issuing is live.

import { awxGet } from "./client";

export interface WalletBalance {
  currency: string;
  available_amount?: number;
  total_amount?: number;
  pending_amount?: number;
}

export function getWalletBalances(): Promise<WalletBalance[]> {
  return awxGet<WalletBalance[]>("/api/v1/balances/current");
}
