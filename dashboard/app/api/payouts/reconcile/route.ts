// Reconciles card-rail payouts against live Airwallex state and PERSISTS the
// result — the write-side counterpart to app/api/payouts/live-status/route.ts,
// which is deliberately read-only (see liveSummary.ts's header for why a
// manual drift-viewer must never also mutate financial state on its own). The
// actual decide-and-write logic lives in lib/airwallex/reconcile.ts +
// lib/airwallex/reconcilePatch.ts; this route is just the auth + row-loading
// wiring around it.
//
// Dual-triggered, same pattern as /api/outbox/drain, /api/orders/waves/tick,
// /api/cx/alert-sweep and /api/payouts/held-sweep: the ingest-worker cron
// pokes this every minute with the shared OUTBOX_SECRET header (see
// ingest-worker/src/index.ts's scheduled()), and an allow-listed finance/admin
// staff member can also trigger it by hand — same requireRole("finance",
// "admin") gate every other payout-writing route already uses (live-status,
// [id]/live, [id]/adjust-limit), not a new auth scheme.
//
// Two modes:
//  - No `ids` in the body (the shape the cron poke uses): FULL SWEEP over
//    every reconcilable card-rail payout, oldest-first, capped at
//    RECONCILE_MAX_IDS per tick and self-throttled via
//    `app_settings.payout_reconcile_last_run_at` (a claim-style compare-and-
//    swap, same shape as ingest-worker/src/reconcile.ts's
//    claimReconcileRun) — real Airwallex calls are made per card, so a
//    per-minute poke must not turn into a per-minute full sweep.
//  - `{ ids: [...] }`: a staff-picked id list (capped the same way
//    live-status's POST already caps its bulk check), bypasses the throttle —
//    a bounded, human-initiated action. Any id in the list that isn't
//    actually reconcilable (wrong rail, terminal status, no card, test shop)
//    comes back with a reason, never silently dropped.
//
// WHY THIS LIVES IN THE DASHBOARD, NOT THE INGEST WORKER: the Airwallex
// client (lib/airwallex/*) only exists on the dashboard side — the Worker has
// no Airwallex credentials or SDK, the same reason webhookMap.ts/cards.ts
// live here. Porting the client to the Worker to run this sweep there would
// duplicate it; calling back into the dashboard is the same shape every other
// cron-driven dashboard job (outbox drain, wave tick, cx alerts, held-payout
// sweep) already uses.

import { createServiceClient } from "@/lib/supabaseAdmin";
import { requireRole, jsonError } from "@/lib/apiAuth";
import { PAYOUT_COLUMNS, loadManualTestShopFlags, toLiveCheckRow, type PayoutLiveRow } from "@/lib/airwallex/payoutRailRows";
import { bulkFetchLive } from "@/lib/airwallex/liveFetch";
import { reconcileCardPayouts, type ReconcileRowResult } from "@/lib/airwallex/reconcile";
import { RECONCILABLE_STATUSES } from "@/lib/airwallex/reconcilePatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same blast-radius cap live-status's POST already uses for a manual batch —
// also doubles as the full-sweep page size, so the whole reconcilable
// population drains over a handful of throttled ticks rather than one.
const RECONCILE_MAX_IDS = 25;
const RECONCILE_THROTTLE_MS = 5 * 60_000; // full sweep runs at most every ~5 minutes

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase-js admin client is loosely typed
async function claimReconcileSweep(admin: any): Promise<boolean> {
  const cutoffIso = new Date(Date.now() - RECONCILE_THROTTLE_MS).toISOString();
  const { data, error } = await admin
    .from("app_settings")
    .update({ payout_reconcile_last_run_at: new Date().toISOString() })
    .eq("id", 1)
    .or(`payout_reconcile_last_run_at.is.null,payout_reconcile_last_run_at.lt.${cutoffIso}`)
    .select("id");
  if (error) return false; // fail closed — skipping a tick beats double-running a sweep
  return !!(data && data.length > 0);
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.OUTBOX_SECRET;
  const provided = request.headers.get("x-outbox-secret");
  const bySecret = !!secret && provided === secret;

  if (!bySecret) {
    const gate = await requireRole("finance", "admin");
    if (!gate.ok) return gate.res;
  }

  // The cron poke sends no body at all; a staff-picked batch sends {ids}. An
  // unparseable body is treated the same as "no ids" rather than a 400 — the
  // cron path must never be one content-type header away from throttled-off.
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const idsInput = (body as { ids?: unknown } | null)?.ids;

  let ids: string[] | null = null;
  if (idsInput !== undefined) {
    if (!Array.isArray(idsInput) || idsInput.length === 0 || !idsInput.every((id) => typeof id === "string")) {
      return jsonError("`ids`, when provided, must be a non-empty array of strings.", 400);
    }
    if (idsInput.length > RECONCILE_MAX_IDS) {
      return jsonError(`At most ${RECONCILE_MAX_IDS} payout ids per request.`, 400);
    }
    ids = idsInput;
  }

  const admin = createServiceClient();

  if (ids === null) {
    const claimed = await claimReconcileSweep(admin);
    if (!claimed) return Response.json({ ran: false, reason: "throttled" }, { headers: { "Cache-Control": "no-store" } });
  }

  // A staff-picked id list is loaded verbatim (no status/rail pre-filter) so
  // a non-reconcilable id in the batch comes back with a reason instead of
  // vanishing. The full-sweep path filters at the DB level — no point pulling
  // rows reconcileCardPayouts would just report as skipped by the thousand.
  const query = ids
    ? admin.from("payouts").select(PAYOUT_COLUMNS).in("id", ids)
    : admin
        .from("payouts")
        .select(PAYOUT_COLUMNS)
        .eq("rail", "card")
        .in("status", [...RECONCILABLE_STATUSES])
        .order("created_at", { ascending: true })
        .limit(RECONCILE_MAX_IDS);

  const { data, error } = await query;
  if (error) return jsonError("Could not load payouts.", 500);

  const rawRows = (data ?? []) as unknown as PayoutLiveRow[];
  const manualTestShopFlags = await loadManualTestShopFlags(admin, rawRows);
  const rows = rawRows.map((p) => toLiveCheckRow(p, manualTestShopFlags));

  const results: ReconcileRowResult[] = await reconcileCardPayouts(admin, rows, bulkFetchLive);
  return Response.json({ ran: true, results }, { headers: { "Cache-Control": "no-store" } });
}
