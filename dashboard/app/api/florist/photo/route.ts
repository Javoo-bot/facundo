import { currentFlorist } from "@/lib/floristAuth";
import { resolveViewAs } from "@/lib/viewAs";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { jsonError } from "@/lib/apiAuth";
import { payoutOnDelivered, releaseHeldPayout, getTotalPayoutForAssignment } from "@/lib/payout";
import { gateWriteback } from "@/lib/shopifyWriteback";
import { markOutForDelivery } from "@/lib/shopifyFulfillment";
import { gateClientEmail } from "@/lib/clientComms";
import { verifyDeliveryPhoto, verificationAvailable, type ExpectedItem } from "@/lib/photoVerify";
import { sniffImageMedia, extensionFor, mediaTypeMismatch } from "@/lib/imageType";
import { photoFeedback, reuploadDecision } from "@/lib/photoFeedback";
import { captureError } from "@/lib/monitor";
import { traceAgentRun } from "@/lib/agentTrace";
import { agentSpec } from "@/lib/agents/registry.generated";
import { getCloudflareContext } from "@opennextjs/cloudflare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 8 * 1024 * 1024;
const OK_TYPES = ["image/jpeg", "image/png", "image/webp"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase admin rows are loosely typed
type Admin = any;

// The reason a held delivery leg was parked, from the event written at park
// time (lib/payoutHold.ts). Only `photo-verdict` may be cleared by a better
// photo — a tier hold or a provisional-shop hold is a finding about the SHOP,
// and no amount of re-photographing should release it. Same discipline as
// shouldSweepReleaseHeldPayout.
async function heldReason(admin: Admin, payoutId: string): Promise<string | null> {
  const { data } = await admin
    .from("payment_events")
    .select("payload")
    .eq("payout_id", payoutId)
    .eq("type", "held_for_review")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as Admin)?.payload?.reason ?? null;
}

export async function POST(request: Request): Promise<Response> {
  const me = await currentFlorist();
  if (!me) return jsonError("Not signed in as a florist.", 401);

  const form = await request.formData();
  const assignmentId = form.get("assignmentId");
  const type = form.get("type"); // 'ready' | 'delivered'
  const file = form.get("file");
  if (typeof assignmentId !== "string" || (type !== "ready" && type !== "delivered") || !(file instanceof File)) {
    return jsonError("assignmentId, type ('ready'|'delivered') and file are required.", 400);
  }
  if (file.size > MAX_BYTES) return jsonError("File too large (max 8 MB).", 413);
  if (file.type && !OK_TYPES.includes(file.type)) return jsonError("Only JPEG/PNG/WebP.", 415);

  const admin = createServiceClient();
  // OWNERSHIP + state: the assignment must be this florist's and accepted.
  const { data: a } = await admin.from("order_assignments").select("id, order_id, florist_id, status, payout_price").eq("id", assignmentId).single();
  if (!a || a.florist_id !== me.floristId) return jsonError("Not your order.", 403);
  if (a.status !== "accepted" && a.status !== "delivered") return jsonError("Order not accepted.", 409);

  const bytes = await file.arrayBuffer();

  // THE BYTES DECIDE, not `file.type`. A browser announcing WebP bytes as
  // image/jpeg used to sail through here and get rejected by Anthropic four
  // steps later ("the image appears to be a image/webp image"), which the
  // florist then saw as an unexplained hold on their 30%. See lib/imageType.ts.
  const media = sniffImageMedia(bytes);
  if (!media) {
    return jsonError("We couldn't read that file as a photo. Please send a JPEG, PNG or WebP image straight from your camera or gallery.", 415);
  }
  if (mediaTypeMismatch(file.type, media)) {
    // Not an error — we've already corrected it — but worth seeing if it spikes.
    console.warn("photo.media_mismatch", { declared: file.type || null, actual: media });
  }

  // Re-upload gate (delivered proof only): a florist whose photo was held may
  // send a better one, up to MAX_PHOTO_ATTEMPTS. Once the leg has actually been
  // paid there is nothing left to release, so the answer is a plain 409 rather
  // than a silent no-op.
  let deliveryPayout: { id: string; status: string } | null = null;
  if (type === "delivered") {
    const { data: existing } = await admin
      .from("payouts")
      .select("id, status")
      .eq("assignment_id", assignmentId)
      .eq("leg", "delivery")
      .not("status", "in", "(failed,clawed_back)")
      .maybeSingle();
    deliveryPayout = (existing as Admin) ?? null;
    const { count } = await admin
      .from("photo_verifications")
      .select("id", { count: "exact", head: true })
      .eq("assignment_id", assignmentId);
    const gate = reuploadDecision({ attempts: count ?? 0, payoutStatus: deliveryPayout?.status ?? null });
    if (!gate.allowed) {
      return gate.reason === "already-paid"
        ? jsonError("This delivery has already been paid — there's nothing left to review.", 409)
        : jsonError("You've sent the most photos we can check automatically. A Facundo colleague is reviewing this one.", 409);
    }
  }

  const key = `orders/${a.order_id}/${type}-${assignmentId}.${extensionFor(media)}`;
  const { env } = getCloudflareContext();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- R2 binding untyped at build time (runtime provides env.PHOTOS)
  await (env as any).PHOTOS.put(key, bytes, { httpMetadata: { contentType: media } });

  await admin.from("delivery_events").insert({ assignment_id: assignmentId, type: `${type}_photo`, photo_key: key });
  await admin.from("order_events").insert({ order_id: a.order_id, type: `${type}_photo`, payload: { key }, actor: me.email });
  // On the delivered photo, issue the delivery leg — best-effort (must never fail the upload).
  let earned: { amount: number; currency: string; payoutId: string | null; hasCard: boolean } | null = null;
  let held = false;
  // This florist's tier paid the whole payout on accept, so there is no delivery
  // leg and `earned`/`held` are both legitimately empty. Reported explicitly so
  // the client can tell "nothing owed, by design" apart from "the payout call
  // fell over", which look identical otherwise. See lib/payoutMath.ts.
  let singlePayment = false;
  if (type === "delivered") {
    // Mark the order delivered so the florist (and staff) see the state change.
    // Idempotent: a second upload just re-sets the same terminal status.
    await admin.from("order_assignments").update({ status: "delivered" }).eq("id", assignmentId);
    await admin.from("orders").update({ status: "delivered" }).eq("id", a.order_id);

    // AI photo-verification gate (Claude + Gemini consensus). Best-effort: any
    // failure leaves the verdict undefined, which RELEASES the 30% — an absent
    // verdict means the check never ran, which is not a finding against the
    // photo, and our outage shouldn't become the florist's wait. `review` and
    // `fail` are findings and do hold. See lib/payoutHold.ts.
    let verdict: "pass" | "review" | "fail" | undefined;
    // The florist-facing explanation, built from the same row we persist so the
    // page and the upload response can never tell different stories.
    let feedback: ReturnType<typeof photoFeedback> = null;
    try {
      const { data: cfg } = await admin.from("app_settings").select("photo_verify_claude, photo_verify_gemini, photo_verify_openrouter").eq("id", 1).single();
      const providers = { claude: cfg?.photo_verify_claude ?? true, gemini: cfg?.photo_verify_gemini ?? true, openrouter: cfg?.photo_verify_openrouter ?? true };
      if (verificationAvailable(providers)) {
        const { data: items } = await admin.from("order_line_items").select("title, variant, product_type, bouquet_spec, quantity, image_url").eq("order_id", a.order_id);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase admin rows are loosely typed
        const expected: ExpectedItem[] = (items ?? []).map((i: any) => ({ title: i.title, variant: i.variant, productType: i.product_type, spec: i.bouquet_spec, quantity: i.quantity ?? 1, imageUrl: i.image_url ?? null }));
        const result = await verifyDeliveryPhoto({ photoBytes: bytes, mediaType: media, items: expected, providers });
        verdict = result.verdict;
        feedback = photoFeedback({ verdict: result.verdict, confidence: result.confidence, providers: result.providers });
        const orGemini = result.openrouter?.gemini; // shadow-mode opinions — logged only, never drive `verdict`
        const orQwen = result.openrouter?.qwen;
        const trace = traceAgentRun({
          agent: "hawkeye",
          sessionId: a.order_id,
          input: { photoKey: key, items: expected },
          output: { verdict: result.verdict, confidence: result.confidence, reasoning: result.reasoning },
          metadata: { verdict: result.verdict, confidence: result.confidence, assignment_id: assignmentId },
          generations: result.calls,
        });
        await admin.from("photo_verifications").insert({
          order_id: a.order_id, assignment_id: assignmentId, photo_key: key,
          verdict: result.verdict, confidence: result.confidence, providers: result.providers,
          items_expected: expected, reasoning: result.reasoning,
          ai_context: {
            agent: "hawkeye",
            photoKey: key,
            calls: result.calls.map(({ name, model, input }) => ({ name, model, input })),
            rulesHash: agentSpec("hawkeye").rulesHash,
          },
          openrouter_gemini_score: orGemini?.score ?? null, openrouter_gemini_matched: orGemini?.matched ?? null,
          openrouter_gemini_confidence: orGemini?.confidence ?? null, openrouter_gemini_notes: orGemini?.notes ?? null,
          openrouter_gemini_model: orGemini?.model ?? null, openrouter_gemini_ok: orGemini?.ok ?? null, openrouter_gemini_error: orGemini?.error ?? null,
          openrouter_qwen_score: orQwen?.score ?? null, openrouter_qwen_matched: orQwen?.matched ?? null,
          openrouter_qwen_confidence: orQwen?.confidence ?? null, openrouter_qwen_notes: orQwen?.notes ?? null,
          openrouter_qwen_model: orQwen?.model ?? null, openrouter_qwen_ok: orQwen?.ok ?? null, openrouter_qwen_error: orQwen?.error ?? null,
        });
        await admin.from("order_events").insert({ order_id: a.order_id, type: "photo_verified", payload: { verdict: result.verdict, confidence: result.confidence }, actor: "system" });
        await trace;
      }
    } catch (e) {
      console.error("photoVerify", e);
    }

    if (deliveryPayout?.status === "held") {
      // RE-UPLOAD onto an already-parked leg. payoutOnDelivered can't help here:
      // the partial unique index on (assignment_id, leg) makes a second insert a
      // 23505 that reads as "already-issued", so the better photo would change
      // nothing and the florist would be right back where they started.
      //
      // Only a leg parked ON THE PHOTO may be cleared this way. A tier-hold or a
      // provisional-shop hold is a finding about the shop, not the picture, and
      // no re-shoot should move it.
      const parkedFor = await heldReason(admin, deliveryPayout.id).catch(() => null);
      const stillBad = verdict === "review" || verdict === "fail";
      await admin.from("payment_events").insert({
        payout_id: deliveryPayout.id,
        type: "photo_reverified",
        payload: { verdict: verdict ?? null, parkedFor, cleared: !stillBad && parkedFor === "photo-verdict", by: me.email },
      }).then(() => {}, () => {});
      if (!stillBad && parkedFor === "photo-verdict") {
        const out = await releaseHeldPayout(deliveryPayout.id, `florist:${me.email}:photo-reverified`).catch((e) => {
          captureError("photo.reverify_release_failed", e);
          return null;
        });
        earned = out?.added ? { amount: out.amount, currency: out.currency, payoutId: out.payoutId, hasCard: out.hasCard } : null;
        held = !out?.added;
      } else {
        held = true;
      }
    } else {
      const payout = await payoutOnDelivered(assignmentId, verdict).catch((e) => {
        console.error("payoutOnDelivered", e);
        return null;
      });
      earned = payout?.added
        ? { amount: payout.amount, currency: payout.currency, payoutId: payout.payoutId, hasCard: payout.hasCard }
        : null;
      held = payout?.held ?? false; // 30% parked for CX approval
      singlePayment = payout?.singlePayment ?? false; // paid in full on accept — no second leg exists
    }
    // "Tookan Cost Of Order" was already sent at accept (the quoted
    // payout_price — see app/api/florist/respond/route.ts). Delivery only
    // re-sends it when the REAL total (accept + delivery legs actually
    // issued) turns out different — e.g. the delivery leg landed held, or the
    // order was edited after accept. Same value → omit it here; the accept-time
    // write stands. Read AFTER the held/re-upload branch above so a
    // just-released re-upload leg is reflected too. Best-effort, same as
    // everything else in this block: must never fail the upload.
    const realTotal = await getTotalPayoutForAssignment(assignmentId).catch((e) => {
      console.error("getTotalPayoutForAssignment", e);
      return null;
    });
    const quotedCents = a.payout_price != null ? Math.round(a.payout_price * 100) : null;
    const realCents = realTotal ? Math.round(realTotal.amount * 100) : null;
    const totalPayout = realTotal && realCents !== quotedCents ? realTotal : null;
    // Staff-facing Shopify write-back — semi-gated (files a CX approval in step mode,
    // writes immediately otherwise); best-effort, must never fail the upload.
    const { data: ord } = await admin.from("orders").select("shopify_order_id").eq("id", a.order_id).single();
    if (ord?.shopify_order_id) {
      await gateWriteback(String(ord.shopify_order_id), "delivered", { orderId: a.order_id, totalPayout }).catch(() => {});
      // CUSTOMER-VISIBLE: the bouquet is made and has left the shop, so the
      // Shopify shipment status becomes OUT_FOR_DELIVERY.
      //
      // Not DELIVERED: the photo proves the florist made and dispatched it, not
      // that the recipient has it in hand. We have no signal for actual arrival
      // on this rail, and asserting one we cannot observe is how a "delivered"
      // order turns into a support ticket. See lib/shopifyFulfillment.ts.
      //
      // Best-effort, like everything else in this block: never fail the upload,
      // which has already earned the florist their delivery leg.
      await markOutForDelivery(String(ord.shopify_order_id), {
        orderId: a.order_id,
        actor: me.email,
      }).catch(() => {});
    }
    // Client "delivered" notification — semi-gated, idempotent + test-mode gated, best-effort.
    await gateClientEmail(a.order_id, "delivered").catch(() => {});
    if (held) {
      // Tell them WHY, in the same response that told them it was held. The page
      // renders the same thing on reload (see the order page + FloristOrderDetail).
      const { count } = await admin
        .from("photo_verifications")
        .select("id", { count: "exact", head: true })
        .eq("assignment_id", assignmentId);
      const next = reuploadDecision({ attempts: count ?? 0, payoutStatus: "held" });
      return Response.json({
        ok: true, key, earned, held, singlePayment,
        feedback: feedback ? { ...feedback, canReupload: next.allowed, attemptsLeft: next.attemptsLeft } : null,
      });
    }
  }
  return Response.json({ ok: true, key, earned, held, singlePayment });
}

// Serve a delivery/ready photo back to the florist who owns it. The staff route
// (/api/orders/photo) is allow-list gated, so florists need their own — scoped
// to a photo whose assignment belongs to the signed-in florist. A staff
// "view as florist" session (read-only, re-verified) may fetch a photo owned by
// the VIEWED florist so the order page renders as they see it; uploads (POST)
// stay currentFlorist-gated, so staff still can't add or change a photo.
export async function GET(request: Request): Promise<Response> {
  const me = await currentFlorist();
  const va = me ? null : await resolveViewAs();
  const floristId = me?.floristId ?? va?.floristId ?? null;
  if (!floristId) return jsonError("Not signed in as a florist.", 401);

  const key = new URL(request.url).searchParams.get("key");
  if (!key || !key.startsWith("orders/") || key.includes("..")) return jsonError("Invalid or missing key.", 400);

  const admin = createServiceClient();
  const { data: ev } = await admin.from("delivery_events").select("assignment_id").eq("photo_key", key).limit(1).maybeSingle();
  if (!ev) return jsonError("Photo not found.", 404);
  const { data: a } = await admin.from("order_assignments").select("florist_id").eq("id", ev.assignment_id).maybeSingle();
  if (!a || a.florist_id !== floristId) return jsonError("Not your photo.", 403);

  const { env } = getCloudflareContext();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- R2 binding untyped at build time (runtime provides env.PHOTOS)
  const obj = await (env as any).PHOTOS.get(key);
  if (!obj) return jsonError("Photo not found.", 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "image/jpeg",
      "Cache-Control": "private, max-age=300",
      "Content-Disposition": "inline",
    },
  });
}
