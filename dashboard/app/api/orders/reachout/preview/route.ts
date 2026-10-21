import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { resolveOfferVars } from "@/lib/offerVars";
import { buildOfferEmailContent } from "@/lib/offerEmailContent";
import { isResendable, resendBlockReason } from "@/lib/reachout";
import { offerChannelAvailability, emailSkipReason } from "@/lib/offerChannels";
import type { OrderStatus } from "@/lib/orderStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Renders the REAL offer email — real order, real florist, real locale, real
// payout, real overrides — for the staff "Re-send offer" preview-before-send
// step. Zero writes: resolveOfferVars is called with `mintUnsubscribeToken:
// false` and `mintMagicToken: false`, so this route never mints a florist's
// unsubscribe token nor a sign-in link (see lib/offerVars.ts's PROVABLE
// ZERO-WRITE PROPERTY comment) and never touches
// `outreach`/`order_events`/`order_assignments`.
//
// Gate: requireRole("ops","admin") — same as the resend action it guards, NOT
// admin-only. The existing app/api/settings/message-overrides/preview/route.ts
// is admin-only because it's part of the admin-only template EDITOR (sample
// data, no real order/florist involved); this route is part of the ops-facing
// send flow. An ops user allowed to click "Confirm re-send" must be allowed
// to look first, or the safety step this feature exists for is unavailable to
// exactly the people who need it.
//
// NO-DRIFT NOTE: this preview's HTML can differ from what an actual resend
// would send in exactly TWO hrefs, both of them tokens a preview must not mint:
//
//   1. The unsubscribe link, in the one case where the florist has never been
//      emailed before (no unsubscribe_token yet) — see
//      `unsubscribe_url_is_placeholder` below and lib/offerVars.ts's case (3).
//   2. The CTA / order link, ALWAYS. A real send mints a one-click sign-in
//      token (lib/floristMagicLink.ts); a preview renders the inert sentinel,
//      because minting is a write and because a staffer clicking through a
//      preview must not be handed a live login to a real shop. The link's
//      SHAPE (/florist/m/<token>) is identical, so the preview still shows
//      what the florist will see.
//
// Every other byte comes from the exact same `buildOfferEmailContent` call
// with the exact same resolved variables `sendOffer` would use.
export async function GET(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  const url = new URL(request.url);
  const assignmentId = url.searchParams.get("assignmentId");
  if (!assignmentId) return jsonError("assignmentId is required.", 400);

  const admin = createServiceClient();
  const { data: a } = await admin.from("order_assignments").select("*").eq("id", assignmentId).single();
  if (!a) return jsonError("Assignment not found.", 404);

  const r = await resolveOfferVars(admin, a, { mintUnsubscribeToken: false, mintMagicToken: false });
  const { subject, html, bodyText } = buildOfferEmailContent(r.locale, r.overrides, r.vars);

  const orderStatus = (r.order?.status ?? "received") as OrderStatus;
  const orderDeletedAt = r.order?.deleted_at ?? null;
  const assignmentForGate = { status: a.status, offer_expires_at: a.offer_expires_at, withdrawn_at: a.withdrawn_at ?? null };
  const resendable = isResendable(assignmentForGate, orderStatus, orderDeletedAt);
  // State-based reason only (the same enum the POST 409s on for assignment/
  // order state) — a settings-driven block (no-test-email / florist-no-email)
  // is surfaced separately via `email_leg_reason` below, since it's a
  // different kind of blocker (email configuration, not assignment/order state).
  const blockReason = resendBlockReason(assignmentForGate, orderStatus, orderDeletedAt);

  // PRE-FLIGHT CHANNEL AVAILABILITY, for the send-confirm dialog: which legs
  // can actually carry this offer, and why not when they can't. Email and SMS
  // come from the SAME predicate sendOffer/renotifyOffer apply at send time
  // (lib/offerChannels.ts), so what CX is shown here cannot disagree with what
  // then happens. Push is the exception — its availability is a DB fact, not a
  // function of the resolved vars — so it is looked up here.
  const { count: pushSubs } = await admin
    .from("push_subscriptions")
    .select("endpoint", { count: "exact", head: true })
    .eq("florist_id", a.florist_id);
  const channels = offerChannelAvailability(r, (pushSubs ?? 0) > 0);

  // Kept for the existing consumers of `email_leg` / `email_leg_reason`, but
  // derived from the same predicate as `channels` above rather than repeating
  // the rule a second time in this file.
  const emailReason = emailSkipReason(r);
  const emailLeg: "send" | "skipped" = emailReason ? "skipped" : "send";
  const emailLegReason = emailReason;

  return Response.json({
    ok: true,
    subject,
    html,
    bodyText,
    locale: r.locale,
    variant: r.variant,
    test_mode: r.testMode,
    to: r.to,
    intended: r.intended,
    email_leg: emailLeg,
    email_leg_reason: emailLegReason,
    expires_at_preview: r.expiresAt,
    reply_window: r.vars.replyWindow,
    unsubscribe_url_is_placeholder: r.unsubscribeUrlIsPlaceholder,
    channels,
    resendable,
    block_reason: blockReason,
    prior_status: a.status,
    florist: { id: a.florist_id, name: r.florist?.name ?? null },
  });
}
