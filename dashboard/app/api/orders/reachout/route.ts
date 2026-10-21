import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { payoutOnAccept } from "@/lib/payout";
import { gateWriteback } from "@/lib/shopifyWriteback";
import { fulfilOnAccept } from "@/lib/shopifyFulfillment";
import { gateClientEmail } from "@/lib/clientComms";
import { notifyFloristOfAccept } from "@/lib/acceptComms";
import { mintProvisionalActivation } from "@/lib/coldOfferActivate";
import { provisionalSourceOnAccept } from "@/lib/coldOffer";
import { sendOffer } from "@/lib/reachoutSend";
import { renotifyOffer } from "@/lib/reachoutRenotify";
import { resendBlockReason, parseChannels, type OfferChannel } from "@/lib/reachout";
import { ORDER_STATUS_LABEL, type OrderStatus } from "@/lib/orderStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Action = "send" | "accept" | "decline" | "escalate" | "resend" | "renotify" | "withdraw";


// An offer that hasn't reached a terminal state yet — mirrors
// app/api/florist/respond/route.ts's OPEN_STATUSES. Used to CAS-guard the
// `decline` action below (previously the one uncontrolled write in the
// assignment state machine).
const OPEN_STATUSES = ["candidate", "queued", "sent", "opened"];

const REASON_MAX = 500;

export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: { assignmentId?: string; action?: Action; reason?: string; detail?: string; channels?: unknown; resetWindow?: boolean };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }
  const { assignmentId, action } = body;
  if (!assignmentId || !action) return jsonError("assignmentId and action are required.", 400);

  const admin = createServiceClient();
  const { data: a } = await admin.from("order_assignments").select("*").eq("id", assignmentId).single();
  if (!a) return jsonError("Assignment not found.", 404);

  const event = (type: string, payload?: object) =>
    admin.from("order_events").insert({ order_id: a.order_id, type, payload: payload ?? null, actor: gate.email });

  if (action === "send") {
    // Delegate to the shared offer sender (email + audit + sent/offer_expires_at +
    // order→reaching_out + push). Same helper the auto-advance wave-tick uses, so a
    // manual "offer this candidate" and an automatic advance are byte-identical.
    const channels = parseChannels(body.channels) ?? undefined;
    const r = await sendOffer(assignmentId, gate.email, channels ? { channels } : undefined);
    if (!r.ok) {
      if (r.error === "no-test-email") return jsonError("Test mode is on but no valid test email is set (Settings).", 400);
      if (r.error === "florist-no-email") return jsonError("Florist has no email address.", 400);
      if (r.error === "not-sendable") return jsonError("This offer was already sent or the order is no longer open.", 409);
      return jsonError(`Send failed: ${r.error}`, 502);
    }
    return Response.json({ ok: true, test_mode: r.testMode });
  }

  // Re-deliver a LIVE offer — the florist says they never got it. Changes no
  // assignment state (see lib/reachoutRenotify.ts); the complement of `resend`,
  // which reopens a dead one.
  if (action === "renotify") {
    const channels = parseChannels(body.channels) ?? undefined;
    const r = await renotifyOffer(assignmentId, gate.email, {
      channels,
      resetWindow: body.resetWindow === true,
    });
    if (!r.ok) {
      if (r.error === "assignment-not-found") return jsonError("Assignment not found.", 404);
      if (r.error === "no-test-email") return jsonError("Test mode is on but no valid test email is set (Settings).", 400);
      if (r.error === "florist-no-email") return jsonError("Florist has no email address.", 400);
      if (r.error === "not-live") return jsonError("That offer isn't live — use Send or Re-send instead.", 409);
      if (r.error === "cooling-down") return jsonError("That was just sent. Give it a moment before sending again.", 429);
      if (r.error === "order-deleted" || r.error === "order-cancelled" || r.error === "order-not-open" || r.error === "not-sendable") {
        return jsonError("The order is no longer open.", 409);
      }
      // Every requested channel was skipped or failed — the per-channel results
      // carry the reasons, so hand them back rather than a bare message.
      if (r.error === "no-channel-sent") return Response.json({ ok: false, results: r.results }, { status: 409 });
      return jsonError(`Re-send failed: ${r.error}`, 502);
    }
    return Response.json({
      ok: true, results: r.results, test_mode: r.testMode, test_shop: r.testShop,
      expires_at: r.expiresAt ?? null, to: r.to ?? null,
    });
  }

  if (action === "resend") {
    // Preview gate (app/api/orders/reachout/preview/route.ts) is
    // requireRole("ops","admin") too — same as this action, deliberately: an
    // ops user allowed to send must be allowed to look first, or the safety
    // step is unavailable to exactly the people who need it.
    const { data: ord } = await admin.from("orders").select("status, deleted_at").eq("id", a.order_id).single();
    const orderStatus = (ord?.status ?? "received") as OrderStatus;
    const orderDeletedAt = ord?.deleted_at ?? null;

    // ADVISORY pre-check only — mirrors the exact predicate the client's
    // Re-send button gates on (lib/reachout.ts::isResendable /
    // resendBlockReason) so the 409 reason here can never disagree with why
    // the button was shown. THE SOLE AUTHORITY is the CAS inside
    // sendOffer(..., {resend:true}) below: a pre-check that passes and then
    // races just yields the generic "not-sendable" 409.
    const blockReason = resendBlockReason(
      { status: a.status, offer_expires_at: a.offer_expires_at, withdrawn_at: a.withdrawn_at ?? null },
      orderStatus,
      orderDeletedAt
    );
    if (blockReason) {
      if (blockReason === "not-sent-yet") return jsonError("This offer hasn't been sent yet — use Send.", 409);
      if (blockReason === "already-accepted") return jsonError("That florist already accepted this order.", 409);
      if (blockReason === "assignment-closed") {
        return jsonError(`This assignment is closed (${a.status}) — add or reassign a florist instead.`, 409);
      }
      if (blockReason === "still-live") {
        const until = a.offer_expires_at
          ? new Date(a.offer_expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : null;
        return jsonError(
          until
            ? `That offer is still live until ${until} — decline it first if you need to re-send now.`
            : "That offer is still live — decline it first if you need to re-send now.",
          409
        );
      }
      if (blockReason === "order-cancelled") return jsonError("This order is cancelled.", 409);
      if (blockReason === "order-deleted") return jsonError("This order was deleted.", 409);
      // "order-not-open" — a DIFFERENT florist already holds or fulfilled the order.
      return jsonError(`This order is already ${ORDER_STATUS_LABEL[orderStatus]} — nothing to re-offer.`, 409);
    }

    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, REASON_MAX) || null : null;

    // The reopen is folded INTO sendOffer's atomic claim ({resend:true}) —
    // NOT a separate reopen-then-send — so a wave-cron tick landing in the
    // ~60s gap can never steal the send. See lib/lifecycle.ts's
    // reachout-resend branch for the full race-safety rationale.
    const r = await sendOffer(assignmentId, gate.email, { resend: true, channels: parseChannels(body.channels) ?? undefined });
    if (!r.ok) {
      if (r.error === "no-test-email") return jsonError("Test mode is on but no valid test email is set (Settings).", 400);
      if (r.error === "florist-no-email") return jsonError("Florist has no email address.", 400);
      if (r.error === "not-sendable") {
        return jsonError("This offer was just changed by someone else — reload and try again.", 409);
      }
      return jsonError(`Re-send failed: ${r.error}`, 502);
    }

    // Successful resend on an escalated order: sendOffer's own orders CAS
    // deliberately excludes `escalated` (so a normal/auto send never yanks an
    // order out of the CX urgent queue), so demote it here instead, now that
    // we know the resend actually went out. Unconditional (not gated on the
    // `orderStatus` read above, which is a PRE-CHECK SNAPSHOT taken before
    // sendOffer's several round trips) — a concurrent wave tick could
    // escalate the order in that window, in which case sendOffer's own
    // orders-advance CAS (which also excludes escalated) would no-op AND a
    // guard here would skip too, leaving the order stuck `escalated` with a
    // freshly re-sent live offer sitting on it: exactly the state this
    // feature exists to fix. The update is already CAS-guarded on
    // `.eq("status","escalated")`, so running it unconditionally is a benign
    // no-op whenever the order wasn't (or is no longer) escalated.
    await admin.from("orders").update({ status: "reaching_out" }).eq("id", a.order_id).eq("status", "escalated");

    // Written AFTER sendOffer returns ok, from the PRE-READ snapshot (`a`,
    // read before the claim) — an event written before the claim could be
    // orphaned by a lost race. This row is what preserves the decline the
    // claim just cleared off the assignment columns: `declined_at` is left
    // untouched by design (audit-only — see the comment on the "decline"
    // action below), and this payload additionally captures the reason/detail
    // that the claim nulled.
    await event("offer_resent", {
      assignmentId,
      florist_id: a.florist_id,
      prior_status: a.status,
      prior_decline_reason: a.decline_reason,
      prior_decline_detail: a.decline_detail,
      prior_declined_at: a.declined_at,
      prior_offer_expires_at: a.offer_expires_at,
      locale: r.locale ?? null,
      test_mode: r.testMode,
      expires_at: r.expiresAt,
      reason,
    });

    return Response.json({
      ok: true,
      test_mode: r.testMode,
      expires_at: r.expiresAt,
      to: r.to ?? null,
      locale: r.locale ?? null,
      prior_status: a.status,
    });
  }

  if (action === "accept") {
    // Race lock: only succeeds if the order is still open. First writer wins.
    const { data: won } = await admin.from("orders").update({ status: "accepted" })
      .eq("id", a.order_id).in("status", ["reaching_out", "matched", "received"]).select("id");
    if (!won || won.length === 0) return jsonError("Order already taken.", 409);
    await admin.from("order_assignments").update({ status: "accepted", accepted_at: new Date().toISOString() }).eq("id", assignmentId);
    // Every other candidate on this order expires.
    await admin.from("order_assignments").update({ status: "expired" }).eq("order_id", a.order_id).neq("id", assignmentId).in("status", ["candidate", "queued", "sent", "opened"]);
    await event("order_assigned", { assignmentId, florist_id: a.florist_id });
    // Cold-offer or manual-assign shop accepted on its behalf: mirror
    // app/api/florist/respond — MUST run before payoutOnAccept, which reads
    // `florists.trust_tier` to pick the split; a null tier there is the
    // difference between paying 70% and failing the leg. This SUPPLIES the
    // activation gate's inputs rather than bypassing the gate.
    const provisionalSource = provisionalSourceOnAccept(a.offer_audience);
    if (provisionalSource) {
      await mintProvisionalActivation(admin, a.florist_id, provisionalSource);
    }
    // Best-effort payout of the accept leg — must never fail the accept (recorded + retried out-of-band).
    await payoutOnAccept(a.id).catch((e) => console.error("payoutOnAccept", e));
    // Staff-facing Shopify write-back — best-effort, must never fail the accept.
    // Florist ID + payment both land at accept — see the comment in
    // app/api/florist/respond/route.ts's mirror of this call.
    const { data: ord } = await admin.from("orders").select("shopify_order_id, currency").eq("id", a.order_id).single();
    const { data: fl } = await admin.from("florists").select("name, florist_number").eq("id", a.florist_id).single();
    if (ord?.shopify_order_id) {
      await gateWriteback(String(ord.shopify_order_id), "in_production", {
        florist: fl?.name ?? null,
        floristNumber: fl?.florist_number ?? null,
        orderId: a.order_id,
        totalPayout: a.payout_price != null ? { amount: a.payout_price, currency: ord.currency ?? "EUR" } : null,
      }).catch(() => {});
      // CUSTOMER-VISIBLE fulfilment — the mirror of the same call in
      // app/api/florist/respond/route.ts. Both accept paths must do this: an
      // order accepted by CX on the shop's behalf is just as accepted as one
      // the florist took themselves, and Shopify must say so either way.
      await fulfilOnAccept(String(ord.shopify_order_id), {
        orderId: a.order_id,
        actor: gate.email,
      }).catch(() => {});
    }
    // Client "assigned" notification — semi-gated, idempotent + test-mode gated, best-effort.
    await gateClientEmail(a.order_id, "assigned").catch(() => {});
    // The florist's own "thank you for accepting" — the same message their own
    // Accept sends (app/api/florist/respond). It matters MORE on this path:
    // accepting on their behalf is the one case where the florist wasn't
    // looking at the app when the order became theirs.
    await notifyFloristOfAccept({
      assignmentId: a.id,
      floristId: a.florist_id,
      orderId: a.order_id,
      payout: a.payout_price ?? null,
      actor: gate.email,
    }).catch(() => {});
    return Response.json({ ok: true });
  }

  if (action === "decline") {
    // CAS-guarded (previously the one uncontrolled write in the assignment
    // state machine — `.eq("id", assignmentId)` only, no status check) so a
    // decline can't land on top of a status a different concurrent request
    // already moved past (e.g. an accept, or another decline).
    const { data: won } = await admin
      .from("order_assignments")
      .update({
        status: "declined",
        decline_reason: body.reason ?? null,
        decline_detail: body.detail ?? null,
        declined_at: new Date().toISOString(),
      })
      .eq("id", assignmentId)
      .in("status", OPEN_STATUSES)
      .select("id");
    if (!won || won.length === 0) return jsonError("This offer is no longer open to decline.", 409);
    await event("declined", { assignmentId, reason: body.reason });
    return Response.json({ ok: true });
  }

  if (action === "withdraw") {
    // Takes THIS offer off the table for good. Needed because a lapsed offer is
    // no longer self-closing: lib/lateAccept.ts lets a florist accept an
    // `expired` one while the order is unclaimed, so CX needs a way to say "not
    // this florist" without waiting for the clock or declining on their behalf
    // (which would put words in their mouth and pollute the decline stats).
    //
    // Deliberately NOT a new assignment status: `withdrawn_at` is the flag, so
    // the status check constraint, the AssignmentStatus union, and every switch
    // over status stay untouched. A still-open offer is also moved to `expired`
    // so the wave engine stops treating it as live and promotes the next
    // candidate; an already-terminal one keeps its status and just gains the
    // stamp.
    if (a.withdrawn_at) return jsonError("This offer was already withdrawn.", 409);
    const now = new Date().toISOString();
    const { data: won } = await admin
      .from("order_assignments")
      .update({ withdrawn_at: now })
      .eq("id", assignmentId)
      .is("withdrawn_at", null)
      .select("id");
    if (!won || won.length === 0) return jsonError("This offer was already withdrawn.", 409);
    // Separate CAS so a florist accepting in the same instant keeps their
    // accept — this only closes an offer that is still open.
    await admin
      .from("order_assignments")
      .update({ status: "expired" })
      .eq("id", assignmentId)
      .in("status", OPEN_STATUSES);
    await event("offer_withdrawn", {
      assignmentId,
      florist_id: a.florist_id,
      prior_status: a.status,
      reason: typeof body.reason === "string" ? body.reason.trim().slice(0, REASON_MAX) || null : null,
    });
    return Response.json({ ok: true });
  }

  if (action === "escalate") {
    await admin.from("orders").update({ status: "escalated" }).eq("id", a.order_id);
    await event("escalated", { assignmentId });
    // Staff-facing "needs attention" write-back — semi-gated, best-effort, never leaks to the buyer.
    const { data: ord } = await admin.from("orders").select("shopify_order_id").eq("id", a.order_id).single();
    // No florist NAME is passed on this state (never was) — but if this assignment
    // already has a florist, thread their florist_number through too. If none is
    // known (a.florist_id is null — a pre-match escalation), leave it unset.
    const floristNumber = a.florist_id
      ? ((await admin.from("florists").select("florist_number").eq("id", a.florist_id).single()).data?.florist_number ?? null)
      : null;
    if (ord?.shopify_order_id) {
      await gateWriteback(String(ord.shopify_order_id), "issue", { orderId: a.order_id, floristNumber }).catch(() => {});
    }
    return Response.json({ ok: true });
  }

  return jsonError("Unknown action.", 400);
}
