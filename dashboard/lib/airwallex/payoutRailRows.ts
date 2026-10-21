// Shared "load payouts + their card-rail eligibility shape" helper, factored
// out of app/api/payouts/live-status/route.ts so app/api/payouts/reconcile/route.ts
// (which needs the exact same eligibility computation, plus more columns to
// actually persist a reconciled result) can reuse it verbatim rather than
// re-deriving it — two surfaces computing "is this payout eligible for a live
// Airwallex read" independently is exactly how they'd quietly disagree.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js admin client is loosely typed
type Admin = any;

import type { LiveCheckRow } from "./liveCheckEligibility.ts";

export const PAYOUT_COLUMNS =
  "id, rail, provider_ref, status, card_status, spent_amount, last_txn_id, florist_id, order_assignments(florists(is_test_shop))";

export type PayoutLiveRow = {
  id: string;
  rail: string | null;
  provider_ref: string | null;
  status: string | null;
  card_status: string | null;
  spent_amount: number | null;
  last_txn_id: string | null;
  florist_id?: string | null;
  order_assignments?: { florists?: { is_test_shop?: boolean | null } | null } | { florists?: { is_test_shop?: boolean | null } | null }[] | null;
};

export async function loadManualTestShopFlags(admin: Admin, rows: PayoutLiveRow[]): Promise<Map<string, boolean>> {
  const floristIds = [...new Set(rows.map((p) => p.florist_id).filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (floristIds.length === 0) return new Map();
  const { data } = await admin.from("florists").select("id, is_test_shop").in("id", floristIds);
  return new Map((data ?? []).map((f: { id: string; is_test_shop: boolean | null }) => [f.id, f.is_test_shop === true]));
}

export function toLiveCheckRow(p: PayoutLiveRow, manualTestShopFlags: Map<string, boolean>): LiveCheckRow {
  const assignmentEmbed = p.order_assignments;
  const embeddedFlorist = Array.isArray(assignmentEmbed) ? assignmentEmbed[0]?.florists : assignmentEmbed?.florists;
  return {
    id: p.id,
    rail: p.rail ?? null,
    provider_ref: p.provider_ref ?? null,
    status: p.status ?? null,
    is_test_shop: embeddedFlorist?.is_test_shop === true || (p.florist_id ? manualTestShopFlags.get(p.florist_id) === true : false),
    card_status: p.card_status ?? null,
    spent_amount: p.spent_amount ?? null,
    last_txn_id: p.last_txn_id ?? null,
  };
}
