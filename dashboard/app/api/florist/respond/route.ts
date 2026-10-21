import { currentFlorist } from "@/lib/floristAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { jsonError } from "@/lib/apiAuth";
import { payoutOnAccept } from "@/lib/payout";
import { gateWriteback } from "@/lib/shopifyWriteback";
import { gateClientEmail } from "@/lib/clientComms";
import { fulfilOnAccept } from "@/lib/shopifyFulfillment";
import { notifyFloristOfAccept } from "@/lib/acceptComms";
import { acceptBlockReason, ACCEPT_BLOCK_MESSAGE, ACCEPTABLE_ORDER_STATUSES } from "@/lib/lateAccept";
import { mintProvisionalActivation } from "@/lib/coldOfferActivate";
import { provisionalSourceOnAccept } from "@/lib/coldOffer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The accept predicate, resolved against live order + settings. Shared by the
 *  accept branch and (since lapsed offers became acceptable) the decline gate,
 *  so "can still accept" and "can still decline" cannot drift apart. */
async function lateAcceptBlock(
  admin: ReturnType<typeof createServiceClient>,
  a: { status: string; withdrawn_at: string | null; order_id: string },
) {
  const { data: orderNow } = await admin
    .from("orders").select("status, deleted_at").eq("id", a.order_id).single();
  if (!orderNow) return "order-closed" as const;
  return acceptBlockReason(a, orderNow);
}

export async function POST(request: Request): Promise<Response> {
  const me = await currentFlorist();
  if (!me) return jsonError("Not signed in as a florist.", 401);
  let b: { assignmentId?: string; action?: "accept" | "decline"; reason?: string; detail?: string };
  try { b = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  if (!b.assignmentId || !b.action) return jsonError("assignmentId and action required.", 400);

  const admin = createServiceClient();
  // OWNERSHIP: the assignment must belong to THIS florist.
  // `payout_price` is the florist's TOTAL for the order (not the 70% accept
  // leg) — what the confirmation email states as "Your payout", matching the
  // figure they were offered and the one the order page shows.
  const { data: a } = await admin.from("order_assignments").select("id, order_id, florist_id, status, withdrawn_at, offer_audience, payout_price").eq("id", b.assignmentId).single();
  if (!a || a.florist_id !== me.floristId) return jsonError("Not your offer.", 403);
  // OPEN_STATUSES: an offer that hasn't reached a terminal state yet.
  const OPEN_STATUSES = ["candidate", "queued", "sent", "opened"];
  if (b.action === "decline" && !OPEN_STATUSES.includes(a.status)) {
    // A LAPSED offer can still be declined, as long as it could still be
    // ACCEPTED. This used to be a flat refusal, on the reasoning that there is
    // nothing to gain from declining a lapsed offer. lib/lateAccept.ts then
    // made `expired` acceptable — a lapsed window is not a closed door while
    // the order is unclaimed — and that left the florist a page saying "you can
    // still accept" with no way to say no.
    //
    // So the two are symmetric now: if you can still say yes, you can still say
    // no. Purely additive — every decline that worked before still works — and
    // it does not disturb the wave engine, which has already promoted past this
    // row; declining only marks THIS florist's assignment, and gives us the
    // reason instead of silence.
    const declineBlocked = await lateAcceptBlock(admin, a);
    if (declineBlocked) return jsonError("Offer no longer open.", 409);
  }

  if (b.action === "accept") {
    // ACCEPT precondition lives in lib/lateAccept.ts, shared with the florist
    // UI's Accept button so the refusal here can never contradict the button
    // they were shown. It deliberately admits `expired`: a lapsed window is not
    // a closed door while the order is still unclaimed and there's time to
    // deliver. ADVISORY ONLY — the CAS below is the race authority.
    const { data: orderNow } = await admin
      .from("orders")
      .select("status, delivery_at, deleted_at")
      .eq("id", a.order_id)
      .single();
    if (!orderNow) return jsonError("Order not found.", 404);
    const blocked = acceptBlockReason(a, orderNow);
    if (blocked) {
      return Response.json(
        { ok: false, code: blocked, error: ACCEPT_BLOCK_MESSAGE[blocked] },
        { status: blocked === "order-deleted" ? 410 : 409 }
      );
    }
    // Whether this accept rescued an order already sitting in the CX queue —
    // read BEFORE the CAS, since the CAS is what changes it.
    const wasEscalated = orderNow.status === "escalated";
    // RACE LOCK: first florist to flip the order wins. NOTE: `received` is deliberately
    // excluded — in semi (step) mode an order rests at `received` with candidates
    // written while CX reviews the `match` approval; a candidate florist must NOT be
    // able to self-accept and bypass that gate. Accept requires the match to have gone
    // live (reaching_out/matched). In auto/manual the worker never leaves an order at
    // `received` with candidates, so this doesn't affect them. `escalated` IS included:
    // an order in the CX queue because nobody took it is exactly the one a late yes
    // rescues. Kept in step with ACCEPTABLE_ORDER_STATUSES in lib/lateAccept.ts.
    const { data: won } = await admin.from("orders").update({ status: "accepted" })
      .eq("id", a.order_id).in("status", [...ACCEPTABLE_ORDER_STATUSES]).select("id");
    if (!won || won.length === 0) {
      return Response.json({ ok: false, code: "taken", error: "This order was just taken." }, { status: 409 });
    }
    await admin.from("order_assignments").update({ status: "accepted", accepted_at: new Date().toISOString(), decline_reason: null, decline_detail: null }).eq("id", a.id);
    await admin.from("order_assignments").update({ status: "expired" }).eq("order_id", a.order_id).neq("id", a.id).in("status", ["candidate", "queued", "sent", "opened"]);
    await admin.from("order_events").insert({ order_id: a.order_id, type: "order_assigned", payload: { florist_id: me.floristId }, actor: me.email });
    // An accept that pulled the order back out of the CX queue leaves a trace,
    // so CX can see why it vanished from the attention queue rather than wondering.
    if (wasEscalated) {
      await admin.from("order_events").insert({
        order_id: a.order_id,
        type: "late_accept",
        payload: { assignmentId: a.id, florist_id: me.floristId, was: "escalated", assignment_status: a.status },
        actor: me.email,
      });
    }
    // COLD OFFER or MANUAL ASSIGN: this shop was never in the network — the
    // offer email (or staff attaching them by hand) was how they met us. Mint
    // the provisional activation (trust tier + delivery radius) that makes them
    // a florist.
    //
    // MUST run before payoutOnAccept, which reads `florists.trust_tier` to pick
    // the split: a null tier there is the difference between paying 70% and
    // failing the leg. Note this SUPPLIES the activation gate's inputs rather
    // than bypassing the gate — afterwards the shop passes exactly the filter
    // every other florist passes.
    const provisionalSource = provisionalSourceOnAccept(a.offer_audience);
    if (provisionalSource) {
      await mintProvisionalActivation(admin, me.floristId, provisionalSource);
    }

    // Best-effort payout of the accept leg — must never fail the accept (recorded + retried out-of-band).
    const payout = await payoutOnAccept(a.id).catch((e) => {
      console.error("payoutOnAccept", e);
      return null;
    });
    // Staff-facing Shopify write-back — semi-gated (files a CX approval in step mode,
    // writes immediately otherwise); best-effort, must never fail the accept.
    // Florist ID + payment both land at accept: payment is the quoted
    // payout_price (known now, doesn't wait on the delivery leg existing) —
    // see lib/shopifyWriteback.ts's mapping comment. photo/route.ts re-sends
    // it at delivery only if the real (issued-legs) total ends up different.
    const { data: ord } = await admin.from("orders").select("shopify_order_id, currency").eq("id", a.order_id).single();
    const { data: fl } = await admin.from("florists").select("name, florist_number").eq("id", a.florist_id).single();
    if (ord?.shopify_order_id) {
      await gateWriteback(String(ord.shopify_order_id), "in_production", {
        florist: fl?.name ?? null,
        floristNumber: fl?.florist_number ?? null,
        orderId: a.order_id,
        totalPayout: a.payout_price != null ? { amount: a.payout_price, currency: ord.currency ?? "EUR" } : null,
      }).catch(() => {});
      // CUSTOMER-VISIBLE: flip the Shopify order unfulfilled -> fulfilled. A
      // distinct call from the staff writeback above, behind its own flag, for
      // the reason spelled out in lib/shopifyFulfillment.ts's header. Sends no
      // tracking number and never notifies the customer. Best-effort: the
      // accept and its payout are already committed and must not be undone
      // because Shopify was unreachable.
      await fulfilOnAccept(String(ord.shopify_order_id), {
        orderId: a.order_id,
        actor: me.email,
      }).catch(() => {});
    }
    // Client "assigned" notification — semi-gated, idempotent + test-mode gated, best-effort.
    await gateClientEmail(a.order_id, "assigned").catch(() => {});
    // …and the florist's own "thank you for accepting" (email + SMS). Until
    // this landed, an accept notified the customer, Shopify and CX, and said
    // nothing at all to the person who had just taken the order. Best-effort
    // and non-throwing by construction (lib/acceptComms.ts) — the accept and
    // the payout above are already committed and must not be undone by a
    // courtesy message.
    await notifyFloristOfAccept({
      assignmentId: a.id,
      floristId: me.floristId,
      orderId: a.order_id,
      payout: a.payout_price ?? null,
      actor: me.email,
    }).catch(() => {});
    // Surface a balance increase so the app can celebrate it (null when nothing was added).
    const earned = payout?.added
      ? { amount: payout.amount, currency: payout.currency, payoutId: payout.payoutId, hasCard: payout.hasCard }
      : null;
    return Response.json({ ok: true, accepted: true, earned });
  }

  await admin.from("order_assignments").update({ status: "declined", decline_reason: b.reason ?? null, decline_detail: b.detail ?? null, declined_at: new Date().toISOString() }).eq("id", a.id);
  await admin.from("order_events").insert({ order_id: a.order_id, type: "declined", payload: { florist_id: me.floristId, reason: b.reason }, actor: me.email });
  return Response.json({ ok: true });
}
