import { createServiceClient } from "@/lib/supabaseAdmin";
import { sendOffer } from "@/lib/reachoutSend";
import { notifyFloristOfIssue } from "@/lib/issueComms";
import { reassignOrder } from "@/lib/reassignOrder";
import { deliverWriteback } from "@/lib/shopifyWriteback";
import { deliverClientEmail, type ClientNoticeKind } from "@/lib/clientComms";
import { captureError } from "@/lib/monitor";
import { rejectStatusFor } from "@/lib/approvalKinds";
import { parseIngestRequest, queueIngestForArea } from "@/lib/autoIngest";
import type { OrderApprovalKind } from "@/lib/types";
import type { OfferChannel } from "@/lib/reachout";

// Runs an approved (or rejected) order_approvals step. On APPROVE, reconstructs the
// deferred effect from `kind` + `payload` and calls the same idempotent functions the
// inline (manual/auto) path uses. On REJECT, runs the per-kind decline side-effect.
// Money (70%/30%) is NOT here — held payouts keep their own release/reject routes.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- supabase admin rows are loosely typed
type Approval = any;
type Edits = { subject?: string | null; body?: string | null };
type Result = { ok: boolean; error?: string };

const NOTICE_OF: Record<string, ClientNoticeKind> = {
  client_assigned: "assigned",
  client_on_the_way: "on_the_way",
  client_delivered: "delivered",
};

// Approve → fire the effect. Returns { ok:false, retryable:true } when the effect
// couldn't run for a transient reason so the caller can roll the approval back to
// pending. A benign no-op (the order already moved past this step) returns ok:true.
async function runApprove(admin: Approval, appr: Approval, actor: string, edits?: Edits, channels?: readonly OfferChannel[]): Promise<Result & { retryable?: boolean }> {
  const kind = appr.kind as OrderApprovalKind;

  if (kind === "offer") {
    if (!appr.assignment_id) return { ok: false, error: "no-assignment" };
    if (edits && (edits.subject != null || edits.body != null)) {
      await admin.from("order_assignments").update({
        ...(edits.subject != null ? { draft_subject: edits.subject } : {}),
        ...(edits.body != null ? { draft_body: edits.body } : {}),
      }).eq("id", appr.assignment_id);
    }
    // Channels chosen in the send-confirm dialog. Undefined (the wave engine,
    // or an approval taken without the dialog) keeps the previous behaviour of
    // every enabled channel firing.
    const r = await sendOffer(appr.assignment_id, actor, channels?.length ? { channels } : undefined);
    // "not-sendable" = the candidate is no longer offerable (already offered/expired) —
    // don't roll back; the wave engine will file a fresh approval. Anything else is
    // retryable (e.g. no test email configured yet).
    if (!r.ok) return { ok: false, error: r.error, retryable: r.error !== "not-sendable" };
    return { ok: true };
  }

  if (kind === "match") {
    // Approve the match → make the ranked candidates live. CAS from 'received'; if the
    // order already moved on, that's a benign no-op (and we don't stamp a stale event).
    const { data: moved } = await admin.from("orders").update({ status: "matched" }).eq("id", appr.order_id).eq("status", "received").select("id");
    if (moved?.length) await admin.from("order_events").insert({ order_id: appr.order_id, type: "matched", payload: { via: "approval" }, actor });
    return { ok: true };
  }

  if (kind === "escalate") {
    const from = (appr.payload?.from as string | undefined) ?? null;
    const q = admin.from("orders").update({ status: "escalated" }).eq("id", appr.order_id);
    if (from) q.eq("status", from);
    const { data: moved } = await q.select("id");
    if (moved?.length) await admin.from("order_events").insert({ order_id: appr.order_id, type: "escalated", payload: { via: "approval", reason: appr.payload?.reason ?? null }, actor });

    // An escalation for "nobody in range" carries the area worth scraping (see
    // ingest-worker/src/lateMatch.ts). Approving it is what authorises the
    // spend — order_approvals allows one pending row per order, so the ingest
    // can't be its own approval. Best-effort: the escalation itself has already
    // succeeded and must not be undone by a queueing problem.
    const area = parseIngestRequest(appr.payload?.queue_ingest);
    if (area) {
      const outcome = await queueIngestForArea(admin, area);
      await admin.from("order_events").insert({
        order_id: appr.order_id, type: "ingest_queued",
        payload: { country: area.country, city: area.city, radius_km: area.radiusKm, outcome, via: "approval" },
        actor,
      });
    }
    return { ok: true };
  }

  if (kind === "chase_photo") {
    // Ask the shop that accepted to prove they are on it. NOT a reassign: the
    // order stays theirs, and this is the message that gives them the chance to
    // keep it.
    //
    // Raised as an `order_issues` row rather than a bare email so it lands in
    // the florist's Messages tab too — an email can be missed, and the app is
    // where they already look. Carrying read state and a resolution comes free
    // with that table, so "did they ever answer" is answerable later.
    const { data: a } = await admin
      .from("order_assignments")
      .select("id, florist_id, florists(email, locale)")
      .eq("id", appr.assignment_id ?? "")
      .maybeSingle();
    if (!a) return { ok: false, error: "Assignment not found for this order.", retryable: false };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped Supabase join shape
    const f = (a as any).florists;
    const florist = Array.isArray(f) ? f[0] : f;

    const { data: ord } = await admin.from("orders").select("order_name").eq("id", appr.order_id).single();
    const detail =
      "You accepted this order and we have not seen it start yet. Could you upload a photo when it is " +
      "ready? That is all we need to know it is in hand.";

    const { data: issue, error: iErr } = await admin
      .from("order_issues")
      .insert({
        order_id: appr.order_id,
        assignment_id: a.id,
        type: "awaiting_photo",
        detail,
        status: "open",
        created_by: actor,
      })
      .select("id")
      .single();
    // Retryable: the message is the whole point of this approval, so a failed
    // write must not be reported as a chase that happened.
    if (iErr) return { ok: false, error: "Could not raise the request.", retryable: true };

    await notifyFloristOfIssue({
      assignmentId: a.id,
      floristId: a.florist_id,
      orderId: appr.order_id,
      issueId: issue.id,
      floristEmail: florist?.email ?? null,
      floristLocale: florist?.locale ?? null,
      orderName: ord?.order_name ?? null,
      body: detail,
      kind: "reply",
      actor,
    });

    await admin.from("order_events").insert({
      order_id: appr.order_id,
      type: "chase_photo",
      payload: { assignment_id: a.id, issue_id: issue.id, via: "approval" },
      actor,
    });
    return { ok: true };
  }

  if (kind === "reassign") {
    const r = await reassignOrder(appr.order_id, actor);
    if (!r.ok) {
      // No candidate left → escalate rather than leaving it stuck.
      if (r.error === "No further candidate to reassign to.") {
        const { data: moved } = await admin.from("orders").update({ status: "escalated" }).eq("id", appr.order_id).eq("status", "accepted").select("id");
        if (moved?.length) {
          // CLOSE THE ASSIGNMENT TOO, or the two sides disagree about who holds
          // the order. Escalating the order alone leaves the assignment at
          // `accepted`, and the florist app lists an accepted assignment
          // UNCONDITIONALLY, whatever the order's status
          // (app/florist/(app)/page.tsx filters only `expired` rows). The shop a
          // human has just decided to take the order away from would go on
          // seeing it as theirs, and make the bouquet.
          //
          // `released` is the honest word — "given back": we withdrew it, they
          // did not refuse it, and it went to nobody. It is absent from the
          // florist list's filter (so the order leaves their app), from
          // callCard's CALLABLE_STATUSES (so we never offer to phone them about
          // an order they no longer hold) and from lateAccept's acceptable
          // statuses (so a stale link cannot resurrect it).
          //
          // CAS'd on `accepted` so a florist uploading their ready photo in the
          // same moment wins and keeps the order.
          const { data: closed } = await admin
            .from("order_assignments")
            .update({ status: "released" })
            .eq("order_id", appr.order_id)
            .eq("status", "accepted")
            .select("id");
          await admin.from("order_events").insert({
            order_id: appr.order_id,
            type: "escalated",
            payload: { via: "approval", reason: "reassign_no_candidate", assignment_released: !!closed?.length },
            actor,
          });
        }
        return { ok: true };
      }
      return { ok: false, error: r.error, retryable: true };
    }
    return { ok: true };
  }

  if (kind === "writeback") {
    const p = appr.payload ?? {};
    await deliverWriteback(String(p.shopifyOrderId), p.state as Parameters<typeof deliverWriteback>[1], {
      orderId: appr.order_id,
      florist: (p.florist as string | null | undefined) ?? null,
      // Nothing has been deployed with the old `odooFloristId` key, so no
      // migration shim — just a typeof guard against a persisted payload that
      // isn't a number (rather than risk NaN from a stray cast).
      floristNumber: typeof p.floristNumber === "number" ? p.floristNumber : null,
      totalPayout: (p.totalPayout as { amount: number; currency: string } | null | undefined) ?? null,
    }, actor);
    return { ok: true }; // best-effort; failures are logged + outbox-retryable
  }

  if (kind === "client_assigned" || kind === "client_on_the_way" || kind === "client_delivered") {
    await deliverClientEmail(appr.order_id, NOTICE_OF[kind], edits);
    return { ok: true }; // idempotent claim + best-effort send
  }

  return { ok: false, error: `unknown-kind:${kind}` };
}

// Reject → the per-kind decline side-effect.
async function runReject(admin: Approval, appr: Approval, actor: string): Promise<void> {
  const kind = appr.kind as OrderApprovalKind;
  if (kind === "offer" && appr.assignment_id) {
    // Skip this candidate: expire it so the wave promotes the next-ranked one.
    await admin.from("order_assignments").update({ status: "expired" })
      .eq("id", appr.assignment_id).in("status", ["candidate", "queued", "sent", "opened"]);
    await admin.from("order_events").insert({ order_id: appr.order_id, type: "offer_skipped", payload: { assignmentId: appr.assignment_id }, actor });
    return;
  }
  if (kind === "match") {
    // Rejecting the auto-match → send it to CX to place by hand.
    await admin.from("orders").update({ status: "escalated" }).eq("id", appr.order_id).eq("status", "received").select("id");
    await admin.from("order_events").insert({ order_id: appr.order_id, type: "escalated", payload: { reason: "match_rejected" }, actor });
    return;
  }
  // escalate / reassign / writeback / client_* → nothing to undo; the approval row
  // marked rejected/skipped is the record. (A rejected client email simply never sends.)
}

// Public API — one approve, one reject, over every kind. Both CAS-claim the pending
// approval so two operators can't double-act.
export async function approveApproval(approvalId: string, actor: string, edits?: Edits, channels?: readonly OfferChannel[]): Promise<Result> {
  const admin = createServiceClient();
  const { data: claimed } = await admin.from("order_approvals")
    .update({ status: "approved", decided_by: actor, decided_at: new Date().toISOString() })
    .eq("id", approvalId).eq("status", "pending").select("*").maybeSingle();
  if (!claimed) return { ok: false, error: "not-pending" };

  try {
    const r = await runApprove(admin, claimed, actor, edits, channels);
    if (!r.ok && r.retryable) {
      // Roll back so the operator can retry.
      await admin.from("order_approvals").update({ status: "pending", decided_by: null, decided_at: null })
        .eq("id", approvalId).eq("status", "approved");
    }
    return { ok: r.ok, error: r.error };
  } catch (e) {
    captureError("approvals.execute", e);
    await admin.from("order_approvals").update({ status: "pending", decided_by: null, decided_at: null })
      .eq("id", approvalId).eq("status", "approved");
    return { ok: false, error: "exception" };
  }
}

export async function rejectApproval(approvalId: string, actor: string, reason?: string): Promise<Result> {
  const admin = createServiceClient();
  // Read for the kind (drives the target status + side-effect)…
  const { data: appr } = await admin.from("order_approvals").select("*").eq("id", approvalId).eq("status", "pending").maybeSingle();
  if (!appr) return { ok: false, error: "not-pending" };
  // Offers historically move to 'skipped' (try-next semantics); everything else 'rejected'.
  const status = rejectStatusFor(appr.kind);
  // …then CAS-CLAIM the row BEFORE running the side-effect. This mirrors approveApproval
  // so a concurrent approve can't have ITS side-effect (a just-sent offer) clobbered by
  // our reject side-effect: if the approve won the claim, our claim fails here and we
  // never expire its assignment. Worst residual case is a wave tick re-filing a fresh
  // offer approval for a candidate we then expire — which approves to a benign no-op.
  const { data: claimed } = await admin.from("order_approvals")
    .update({ status, decided_by: actor, decided_at: new Date().toISOString(), reason: reason ?? null })
    .eq("id", approvalId).eq("status", "pending").select("id").maybeSingle();
  if (!claimed) return { ok: false, error: "not-pending" };
  await runReject(admin, appr, actor);
  return { ok: true };
}
