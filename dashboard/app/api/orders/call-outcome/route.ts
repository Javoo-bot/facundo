import { requireRole, jsonError } from "@/lib/apiAuth";
import { createServiceClient } from "@/lib/supabaseAdmin";
import { canDeclineInPlace, CALL_DECLINABLE_STATUSES, CALL_DECLINE_REASONS } from "@/lib/callCard";
import type { AssignmentStatus } from "@/lib/orderStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOTE_MAX = 500;

/**
 * Record what happened on a phone call to a florist — the one write the call
 * card at /orders/[id] makes.
 *
 * WHY THIS EXISTS RATHER THAN JUST REUSING `decline` ON /api/orders/reachout.
 * That action is CAS-guarded to OPEN_STATUSES, and rightly so: a self-service
 * decline arriving for an offer that already lapsed is a race and should lose.
 * But the shops actually worth phoning are overwhelmingly the ones whose offer
 * HAS lapsed — that is the entire population the call screen was built for.
 * Sending their refusal to `decline` would 409 every time and the operator's
 * twenty seconds of work would vanish.
 *
 * So the call outcome is recorded in its own right, on `order_events`, whatever
 * state the assignment is in; and where the status can carry it we also write
 * the decline through the same shape the reachout route uses, so the funnel
 * stats and lib/opsStats.ts::bucketDeclineReasons keep seeing declines where
 * they expect them. One human action, recorded once, in up to two places that
 * each need it.
 *
 * WHICH STATUSES CAN CARRY IT is lib/callCard.ts::CALL_DECLINABLE_STATUSES —
 * the reachout guard PLUS `expired`, and that `expired` is load-bearing. This
 * route used to reuse the reachout guard verbatim, so a refusal taken on a
 * lapsed offer wrote the event and nothing else. Every reader downstream looks
 * at the assignment, not at events: the call screen kept handing the operator
 * the same shop, "History with us" read "no refusals" for a shop that had just
 * refused, the Operator row still said "none replied", and the reason typed
 * here never reached opsStats. Fixed 2026-09-02.
 *
 * `accepted` is deliberately NOT handled here: accepting has real
 * consequences (payout leg, Shopify write-back, florist and client comms) that
 * already live in /api/orders/reachout's `accept`, and duplicating them would
 * be a second source of truth for the most expensive transition in the system.
 * The card calls that route for an acceptance.
 *
 * `no_answer` IS handled, and used not to be. "Nobody picked up, so there is
 * nothing to record" was the original reasoning, and it was wrong twice over:
 * the next click served the operator the same shop and the same number with no
 * hint it had just been tried, and a second operator working the same queue
 * could ring it again in parallel. A call that went unanswered is a fact about
 * the shop, not an absence of one. It is written as `call_no_answer`, which
 * lib/callCard.ts turns into a cooldown and a line on the card.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await requireRole("ops", "admin");
  if (!gate.ok) return gate.res;

  let body: { assignmentId?: string; reason?: string; note?: string; outcome?: "refused" | "no_answer" };
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body.", 400); }

  const assignmentId = body.assignmentId;
  if (!assignmentId) return jsonError("assignmentId is required.", 400);

  // Default to "refused" so a caller written before `outcome` existed keeps
  // its old meaning rather than silently becoming a no-answer.
  const outcome = body.outcome === "no_answer" ? "no_answer" : "refused";

  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
  if (reason && !(CALL_DECLINE_REASONS as readonly string[]).includes(reason)) {
    return jsonError("That isn't one of the decline reasons.", 400);
  }
  // The note is optional on purpose — an operator who got nothing useful out of
  // the call should be able to save in one click and move on.
  const note = typeof body.note === "string" && body.note.trim()
    ? body.note.trim().slice(0, NOTE_MAX)
    : null;

  const admin = createServiceClient();
  const { data: a } = await admin
    .from("order_assignments")
    .select("id, order_id, florist_id, status")
    .eq("id", assignmentId)
    .single();
  if (!a) return jsonError("Assignment not found.", 404);

  const status = a.status as AssignmentStatus;

  // The record of the call itself. Always written, whatever the assignment's
  // state — this is the row that makes a lapsed-offer refusal visible at all.
  await admin.from("order_events").insert({
    order_id: a.order_id,
    type: outcome === "no_answer" ? "call_no_answer" : "call_refused",
    payload: { assignmentId, florist_id: a.florist_id, reason, note, assignment_status: status },
    actor: gate.email,
  });

  // Nobody picked up: the shop has told us nothing, so its status must not
  // move. The event above is the entire record, and it is enough — the call
  // screen reads it back as a cooldown and a "you called 20 minutes ago" line.
  if (outcome === "no_answer") return Response.json({ ok: true, declined: false, recorded: "no_answer" });

  // Where the offer is still open, this is also a decline in the ordinary
  // sense. Same CAS guard as the reachout route: if something else moved the
  // assignment on while the operator was on the phone, the event above still
  // stands and only the status update is skipped.
  let declined = false;
  if (canDeclineInPlace(status)) {
    const { data: won } = await admin
      .from("order_assignments")
      .update({
        status: "declined",
        decline_reason: reason,
        decline_detail: note,
        declined_at: new Date().toISOString(),
      })
      .eq("id", assignmentId)
      // Same set canDeclineInPlace() gated on above, re-checked at write time so
      // a florist who answered the email while the operator was on the phone wins.
      .in("status", CALL_DECLINABLE_STATUSES)
      .select("id");
    declined = !!won && won.length > 0;
    if (declined) {
      await admin.from("order_events").insert({
        order_id: a.order_id,
        type: "declined",
        payload: { assignmentId, reason, source: "call" },
        actor: gate.email,
      });
    }
  }

  return Response.json({ ok: true, declined });
}
