import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { loadMatchConfig, applyConfigOverride } from "@/lib/matchConfig";
import { rankForOrder, isRankError } from "@/lib/rematch";
import { refillCandidates, isRefillError } from "@/lib/candidateRefill";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Regenerate florist candidates for an order on demand (the automatic match runs
// only in the ingest worker on webhook intake). Ranks with the saved matching
// config — same weights, rings and cap the worker uses — optionally patched by a
// per-run `config` override from the "Find florists" panel, which is NOT saved.
//
// The ranking itself lives in lib/rematch.ts, shared with the preview route, so
// what the operator saw in the panel is what this writes.
export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: { orderId?: string; config?: unknown };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!body.orderId) return jsonError("orderId is required.", 400);

  const admin = createServiceClient();
  const config = applyConfigOverride(await loadMatchConfig(admin), body.config);
  const result = await rankForOrder(admin, body.orderId, config);
  if (isRankError(result)) return jsonError(result.error, result.status);

  if (result.fresh.length === 0) {
    const considered = result.ranked.length;
    return Response.json({
      ok: true,
      added: 0,
      note: considered
        ? "No further florists matched — everyone in range is already on this order."
        : `No florist matched within ${config.ringEdgesKm[config.ringEdgesKm.length - 1]}km.`,
    });
  }

  // The insert itself lives in lib/candidateRefill.ts, shared with the wave
  // engine's unattended refill, so a panel click and an automatic wave write
  // identical rows (payout lock, race offer kind, rank continuation).
  // `preRanked` hands over the ranking already done above rather than paying
  // for it twice.
  const written = await refillCandidates(admin, body.orderId, config, {
    actor: gate.email,
    configOverridden: body.config != null,
    preRanked: result,
  });
  if (isRefillError(written)) return jsonError(written.error, written.status);

  return Response.json({ ok: true, added: written.added });
}
