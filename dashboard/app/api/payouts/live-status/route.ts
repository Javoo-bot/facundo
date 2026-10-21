// Batch companion to app/api/payouts/[id]/live/route.ts — same read-only
// contract, applied across many payouts at once instead of one.
//
// GET is DB-only triage: no Airwallex calls, just "which of these payouts are
// even eligible for a live read, and which of those look like the 2026-08-11
// incident shape (card_status still null)." Cheap enough to run on every
// /payments list load.
//
// POST is the actual live comparison, bounded to a small id list per call
// (LIVE_CHECK_MAX_IDS) — a deliberate blast-radius limit on real Airwallex
// calls per manual click, not a hard product requirement. Same
// degrade-gracefully-per-card behavior as the single-payout route, fanned out
// over bulkLiveCheck. WRITES NOTHING to `payouts` — see liveSummary.ts's
// header for why a manual button must never also mutate financial state.

import { createServiceClient } from "@/lib/supabaseAdmin";
import { jsonError, requireRole } from "@/lib/apiAuth";
import { selectForLiveCheck, bulkLiveCheck, type LiveCheckRow } from "@/lib/airwallex/liveCheckEligibility";
import { PAYOUT_COLUMNS, loadManualTestShopFlags, toLiveCheckRow, type PayoutLiveRow } from "@/lib/airwallex/payoutRailRows";
import { bulkFetchLive } from "@/lib/airwallex/liveFetch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIVE_CHECK_MAX_IDS = 25;

export async function GET(request: Request): Promise<Response> {
  const authGate = await requireRole("finance", "admin");
  if (!authGate.ok) return authGate.res;

  const idsParam = new URL(request.url).searchParams.get("ids");
  const ids = idsParam
    ? idsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const admin = createServiceClient();
  let query = admin.from("payouts").select(PAYOUT_COLUMNS);
  if (ids && ids.length) query = query.in("id", ids);
  const { data, error } = await query;

  if (error) return jsonError("Could not load payouts.", 500);

  const rawRows = (data ?? []) as unknown as PayoutLiveRow[];
  const manualTestShopFlags = await loadManualTestShopFlags(admin, rawRows);
  const rows: LiveCheckRow[] = rawRows.map((p) => toLiveCheckRow(p, manualTestShopFlags));

  const selection = selectForLiveCheck(rows);
  return Response.json(selection, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const authGate = await requireRole("finance", "admin");
  if (!authGate.ok) return authGate.res;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  const ids = (body as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string")) {
    return jsonError("Provide a non-empty array of payout ids.", 400);
  }
  if (ids.length > LIVE_CHECK_MAX_IDS) {
    return jsonError(`At most ${LIVE_CHECK_MAX_IDS} payout ids per request.`, 400);
  }

  // Never trust anything about payout state from the request body — only the
  // id list. Reload the rows fresh from the DB.
  const admin = createServiceClient();
  const { data, error } = await admin.from("payouts").select(PAYOUT_COLUMNS).in("id", ids);
  if (error) return jsonError("Could not load payouts.", 500);

  const rawRows = (data ?? []) as unknown as PayoutLiveRow[];
  const manualTestShopFlags = await loadManualTestShopFlags(admin, rawRows);
  const rows: LiveCheckRow[] = rawRows.map((p) => toLiveCheckRow(p, manualTestShopFlags));

  // Same three-endpoint fan-out and `partial` leg-naming as the single-payout
  // route and the reconcile route — kept identical (lib/airwallex/liveFetch.ts)
  // so all three surfaces never disagree about what counts as a partial answer.
  const results = await bulkLiveCheck(rows, bulkFetchLive);
  return Response.json({ results }, { headers: { "Cache-Control": "no-store" } });
}
