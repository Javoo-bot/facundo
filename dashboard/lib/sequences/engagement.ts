// The branch switch: a florist clicked something, so the cold track is over.
//
// Driven by the WEBHOOKS (the Resend click event and the short-link redirect),
// not by the tick. The reason is cancellation, not send latency: the
// re-engagement email is due two days later, so a minute of scheduling delay
// is irrelevant — but a florist who clicks at 08:59 must not receive the
// "just following up, no rush" email that the 09:00 tick was about to send.
// That is the single most embarrassing failure this funnel can have, and it
// costs one call in a webhook to close.
//
// Correctness does NOT depend on the webhook arriving. lib/sequences/tick.ts
// re-reads `engaged_at` after it claims a row and before it sends, so a dropped
// click event degrades to "the branch fires up to a tick late" rather than
// "we sent the wrong email".

import { createServiceClient } from "@/lib/supabaseAdmin";
import { captureError } from "@/lib/monitor";
import { applyEngagement, stepOffsetMs, type Enrolment } from "./schedule.ts";
import { sequenceDef, isSequenceId } from "./definitions.ts";
import { loadStepConfig } from "./timingOverrides.ts";
import { applyStepTiming } from "@/lib/flows/timing";
import { resolveSequence } from "@/lib/flows/customSteps";

type Admin = ReturnType<typeof createServiceClient>;

/**
 * Record a florist's first click and flip every live run to the re-engagement
 * track.
 *
 * Idempotent in the way that matters: the update is CAS-guarded on
 * `engaged_at is null`, so a corporate link scanner clicking every URL in the
 * email — twice — cannot rewind the run to step 0 over and over. Outlook Safe
 * Links and Proofpoint do exactly this, so it is a real case, not a hypothetical.
 *
 * Never throws: it is called from inside webhook handlers whose job is to
 * acknowledge the provider.
 */
export async function recordEngagement(
  admin: Admin,
  floristId: string,
  atIso: string
): Promise<number> {
  try {
    const { data: rows, error } = await admin
      .from("sequence_enrolments")
      .select("id, sequence_id, status, track, step_index, created_at, engaged_at, last_touch_at, touches_email, touches_sms")
      .eq("florist_id", floristId)
      .eq("status", "active")
      .is("engaged_at", null);
    if (error) {
      captureError("sequences.recordEngagement.read", error);
      return 0;
    }

    // The waits staff set on /flows. Read once for this florist's runs, not
    // per row: this re-anchors next_action_at, so without it a step whose wait
    // was shortened would still be parked on its code default.
    const stepConfig = await loadStepConfig(admin);

    let flipped = 0;
    for (const row of rows ?? []) {
      if (!isSequenceId(row.sequence_id)) continue;
      const def = resolveSequence(sequenceDef(row.sequence_id), stepConfig, applyStepTiming);

      // The pure transition decides the new state; this function only persists
      // it. Sequences with no re-engagement track (the cold-offer follow-up)
      // still record the click — it is a real signal for /statistics — but
      // there is nothing to switch to, so the track stays put.
      const hasReengage = def.steps.some((s) => s.track === "reengage");
      const next = hasReengage
        ? applyEngagement(row as unknown as Enrolment, atIso)
        : { ...(row as unknown as Enrolment), engaged_at: atIso };

      const reanchor = def.steps.find((s) => s.track === next.track);
      const nextActionAt = reanchor
        ? new Date(Date.parse(atIso) + stepOffsetMs(reanchor)).toISOString()
        : atIso;

      const { data: won } = await admin
        .from("sequence_enrolments")
        .update({
          engaged_at: next.engaged_at,
          track: next.track,
          step_index: next.step_index,
          next_action_at: nextActionAt,
          updated_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .is("engaged_at", null)  // CAS: the first click wins; repeats are no-ops
        .eq("status", "active")
        .select("id");
      if (won?.length) flipped++;
    }
    return flipped;
  } catch (e) {
    captureError("sequences.recordEngagement", e);
    return 0;
  }
}

/**
 * Resolve the florist behind a Resend click event and record it.
 * `communications.florist_id` is already populated by every send site.
 */
export async function recordEmailClick(
  admin: Admin,
  communicationId: string,
  atIso: string
): Promise<void> {
  try {
    const { data } = await admin
      .from("communications")
      .select("florist_id")
      .eq("id", communicationId)
      .maybeSingle();
    const floristId = data?.florist_id as string | null | undefined;
    if (floristId) await recordEngagement(admin, floristId, atIso);
  } catch (e) {
    captureError("sequences.recordEmailClick", e);
  }
}

/**
 * Stamp the first genuine open on every live run for this florist.
 *
 * Deliberately much smaller than recordEngagement: an open does NOT switch
 * track, reset the step index or re-anchor the clock. It is a fact about a
 * message, not a decision by a person — the branch it feeds (t2 vs t3) is
 * evaluated by the scheduler at send time, where a late open can still change
 * the outcome. Writing it here only saves the tick from re-deriving it.
 *
 * CAS-guarded on `opened_at is null` for the same reason as engaged_at: a mail
 * client that fetches the pixel on every render generates a stream of opens,
 * and the FIRST one is the only one that means anything.
 *
 * The caller has already decided this open is genuine (openQuality.ts) — a
 * prefetch never reaches here.
 */
export async function recordEmailOpen(
  admin: Admin,
  communicationId: string,
  atIso: string
): Promise<void> {
  try {
    const { data } = await admin
      .from("communications")
      .select("florist_id")
      .eq("id", communicationId)
      .maybeSingle();
    const floristId = data?.florist_id as string | null | undefined;
    if (!floristId) return;

    await admin
      .from("sequence_enrolments")
      .update({ opened_at: atIso, updated_at: new Date().toISOString() })
      .eq("florist_id", floristId)
      .eq("status", "active")
      .is("opened_at", null);
  } catch (e) {
    captureError("sequences.recordEmailOpen", e);
  }
}

/**
 * A hard bounce or a spam complaint ends the run.
 *
 * Not optional politeness: a funnel that keeps emailing an address that hard-
 * bounced, or someone who pressed "this is spam", is how a sending domain's
 * reputation dies — and it takes every transactional order email down with it.
 */
export async function recordDeliveryFailure(
  admin: Admin,
  communicationId: string,
  kind: "bounced" | "complained"
): Promise<void> {
  try {
    const { data } = await admin
      .from("communications")
      .select("florist_id")
      .eq("id", communicationId)
      .maybeSingle();
    const floristId = data?.florist_id as string | null | undefined;
    if (!floristId) return;

    await admin
      .from("sequence_enrolments")
      .update({
        status: "stopped",
        stop_reason: kind === "complained" ? "opted_out" : "bounced",
        updated_at: new Date().toISOString(),
      })
      .eq("florist_id", floristId)
      .in("status", ["active", "paused"]);

    // A spam complaint is an opt-out in every sense that matters. Honour it on
    // the florist row too, so nothing outside the funnel emails them either.
    if (kind === "complained") {
      await admin.from("florists").update({ order_emails_opt_out: true }).eq("id", floristId);
    }
  } catch (e) {
    captureError("sequences.recordDeliveryFailure", e);
  }
}
