// Reconcile card-rail payouts against live Airwallex state and PERSIST the
// result — the write-side counterpart to liveSummary.ts/liveCheckEligibility.ts,
// which are read-only by design (see their headers). Reuses both verbatim:
// `bulkLiveCheck` still does all the fetching/summarizing/error-isolation
// work; this module only adds the "decide + write" step on top
// (reconcilePatch.ts's computeReconcilePatch/reconcilePatchChanged), plus the
// `payment_events` audit row that distinguishes a reconciled write from a
// webhook-delivered one.
//
// Scope is narrower than a live-check: only payouts in RECONCILABLE_STATUSES
// (pending/issued/held) are considered — a terminal payout (paid/failed/
// clawed_back) is out of scope by definition, even though liveCheckEligibility's
// `cardIfLive` still treats a 'paid' payout as "eligible for a live read" for
// the manual drift-viewer's purposes.

import { bulkLiveCheck, type LiveCheckRow, type SkipReason } from "./liveCheckEligibility.ts";
import { computeReconcilePatch, reconcilePatchChanged, isReconcilableStatus, type StoredPayout } from "./reconcilePatch.ts";
import type { FetchLive } from "./liveFetch.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js admin client is loosely typed
type Admin = any;

export type ReconcileAction = "settled" | "authorized" | "no-change";

export interface ReconcileRowResult {
  id: string;
  eligible: boolean;
  reason?: SkipReason | "not-reconcilable-status";
  action?: ReconcileAction;
  error?: string;
}

/**
 * Reconcile a pre-loaded batch of payout rows. `admin` is injected (not
 * imported) so this is unit-testable with a fake Supabase-shaped client — see
 * reconcile.test.mjs. Every row gets exactly one result entry, never silently
 * dropped, mirroring bulkLiveCheck's own contract.
 */
export async function reconcileCardPayouts(admin: Admin, rows: LiveCheckRow[], fetchLive: FetchLive): Promise<ReconcileRowResult[]> {
  const reconcilable = rows.filter((r) => isReconcilableStatus(r.status));
  const notReconcilable: ReconcileRowResult[] = rows
    .filter((r) => !isReconcilableStatus(r.status))
    .map((r) => ({ id: r.id, eligible: false, reason: "not-reconcilable-status" }));

  const checked = await bulkLiveCheck(reconcilable, fetchLive);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const nowIso = new Date().toISOString();

  const results: ReconcileRowResult[] = [...notReconcilable];

  for (const c of checked) {
    if (!c.eligible) {
      results.push({ id: c.id, eligible: false, reason: c.reason });
      continue;
    }
    if (c.error || !c.summary) {
      results.push({ id: c.id, eligible: true, error: c.error ?? "no live summary returned" });
      continue;
    }

    const storedRow = byId.get(c.id);
    const stored: StoredPayout = {
      status: storedRow?.status ?? null,
      card_status: storedRow?.card_status ?? null,
      spent_amount: storedRow?.spent_amount ?? null,
      last_txn_id: storedRow?.last_txn_id ?? null,
    };

    const { patch, eventType, eventPayload } = computeReconcilePatch(c.summary, nowIso);
    if (!patch || !eventType || !reconcilePatchChanged(stored, patch)) {
      results.push({ id: c.id, eligible: true, action: "no-change" });
      continue;
    }

    const { error: updateError } = await admin.from("payouts").update({ ...patch, updated_at: nowIso }).eq("id", c.id);
    if (updateError) {
      results.push({ id: c.id, eligible: true, error: updateError.message ?? "payout update failed" });
      continue;
    }

    // Audit trail distinguishing "reconciled from live" from "webhook
    // delivered" — same payment_events table, a different `type` and a
    // `source: "reconcile"` marker in the payload (see reconcilePatch.ts).
    await admin.from("payment_events").insert({ payout_id: c.id, type: eventType, payload: eventPayload });

    results.push({ id: c.id, eligible: true, action: eventType === "reconciled_settled" ? "settled" : "authorized" });
  }

  return results;
}
