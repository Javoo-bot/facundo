import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Editable tiers. The sum-to-100 check below accepts 100/0, which is what
// tier 1 is set to — a shop paid in full on accept. 5 is mint-only (see
// lib/coldOffer.ts).
const CODES = ["1", "2", "3", "4"];

export async function GET(): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;
  const { data } = await createServiceClient().from("trust_tiers").select("*").order("code");
  return Response.json({ tiers: data ?? [] });
}

export async function PUT(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;
  let b: { code?: string; split_on_accept?: number; split_on_delivery?: number; photo_required?: boolean; hold_payout?: boolean; exposure_cap_eur?: number | null };
  try { b = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!b.code || !CODES.includes(b.code)) return jsonError("Valid tier code required.", 400);
  if ((b.split_on_accept ?? 0) + (b.split_on_delivery ?? 0) !== 100) return jsonError("Splits must sum to 100.", 400);

  const { error } = await createServiceClient().from("trust_tiers").update({
    split_on_accept: b.split_on_accept, split_on_delivery: b.split_on_delivery,
    photo_required: b.photo_required, hold_payout: b.hold_payout ?? false,
    exposure_cap_eur: b.exposure_cap_eur ?? null, updated_at: new Date().toISOString(),
  }).eq("code", b.code);
  if (error) return jsonError(error.message, 500);
  return Response.json({ ok: true });
}
