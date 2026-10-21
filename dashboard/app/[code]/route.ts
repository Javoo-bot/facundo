import { NextResponse } from "next/server";
import { notFound } from "next/navigation";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { isShortCode } from "@/lib/shortLink";
import { recordEngagement } from "@/lib/sequences/engagement";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resolve a short code to its target.
 *
 * ROOT-MOUNTED on bo.fc.example.net, so a link is `bo.fc.example.net/<code>`.
 * Dropping a path prefix buys two characters per link, which is real headroom
 * against the SMS segment budget this feature exists to protect.
 *
 * That puts this handler at the same level as every staff page route. Two
 * consequences, both handled:
 *   - Staff routes still win: Next resolves static segments before dynamic
 *     ones, so /orders, /payments and friends are untouched (asserted in
 *     lib/hostRouting.test.mjs).
 *   - The converse is the real risk — `operations` and `statistics` are
 *     themselves exactly ten base62 characters, so a code equal to one would be
 *     shadowed and the link permanently dead. lib/shortLink.ts refuses to mint
 *     any code matching a staff segment.
 *
 * The shape is validated here too rather than trusted from the router, so a
 * non-code path never reaches the database.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ code: string }> }
): Promise<Response> {
  const { code } = await params;
  // Identical response for "malformed" and "no such code": nothing about a
  // guess should be observably different from a typo.
  if (!isShortCode(code)) notFound();

  const admin = createServiceClient();
  const { data } = await admin
    .from("short_links")
    .select("code, target_url, hit_count, florist_id")
    .eq("code", code)
    .maybeSingle();
  if (!data) notFound();

  // Hit counting. The redirect is the product; the counter is telemetry, so a
  // failure must never strand a florist on an error page.
  //
  // AWAITED, not fire-and-forget. A floating promise does not survive here: on
  // Workers the isolate is torn down as soon as the response is returned, which
  // cancels in-flight work. That is exactly what happened on the first
  // production test — a perfect 302 with hit_count stuck at 0, while the same
  // code counted correctly under `next dev` because Node keeps the process
  // alive. `ctx.waitUntil` did not rescue it either, so this now simply awaits:
  // one extra round trip on a redirect is a fair price for telemetry that is
  // actually true, and the error is surfaced on a header rather than swallowed.
  const nowIso = new Date().toISOString();
  const priorHits = (data.hit_count as number | null) ?? 0;
  const { error: hitError } = await admin
    .from("short_links")
    .update({
      hit_count: priorHits + 1,
      last_hit_at: nowIso,
      ...(priorHits === 0 ? { first_hit_at: nowIso } : {}),
    })
    .eq("code", code);

  // This IS the click, for SMS. Every link in a text is shortened, so this
  // handler is the only place an SMS engagement can be observed — Resend's
  // click tracking obviously never sees it. Awaited for the same isolate-
  // teardown reason as the hit count above, and it swallows its own errors:
  // a funnel bookkeeping failure must never strand a florist on an error page
  // instead of the order they tapped through to.
  const floristId = data.florist_id as string | null;
  if (floristId) await recordEngagement(admin, floristId, nowIso);

  // 302, never 301 — a permanent redirect would let shared caches pin a
  // credential-bearing URL. no-store for the same reason.
  const res = NextResponse.redirect(data.target_url as string, 302);
  res.headers.set("Cache-Control", "no-store");
  // Diagnostic only, and only on failure: a counter that silently does nothing
  // is worse than one that says why. Carries no florist data.
  if (hitError) res.headers.set("X-Hit-Count-Error", hitError.message.slice(0, 200));
  return res;
}
