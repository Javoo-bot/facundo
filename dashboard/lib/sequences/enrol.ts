// Enrolling, pausing, resuming and stopping a florist's run through a funnel.
//
// The pure decisions live at the bottom (preemption + resume), so the rule an
// order offer relies on — "recruiting pauses, and comes back where it left
// off" — is testable without a database.

import { createServiceClient } from "@/lib/supabaseAdmin";
import { captureError } from "@/lib/monitor";
import { sequenceDef, type SequenceId } from "./definitions.ts";
import { loadStepConfig } from "./timingOverrides.ts";
import { applyStepTiming } from "@/lib/flows/timing";
import { resolveSequence } from "@/lib/flows/customSteps";
import { contactKey } from "./contactIdentity.ts";
import { stepOffsetMs } from "./schedule.ts";

type Admin = ReturnType<typeof createServiceClient>;

export type StopReason =
  | "joined" | "opted_out" | "replied" | "exhausted"
  | "cap_cold" | "cap_email" | "cap_sms" | "bounced" | "staff" | "not_active";

/** Does another listing sharing this shop's inbox already have a live run?
 *
 * Two queries rather than a join: PostgREST cannot express "other rows whose
 * email matches mine" in one request, and the florist count per address is tiny
 * (the worst case on live data is 33). Fails OPEN on a read error — a missed
 * dedupe sends a duplicate, while a false positive would silently drop a real
 * prospect with no trace anywhere. */
async function contactAlreadyEnrolled(admin: Admin, floristId: string): Promise<boolean> {
  try {
    const { data: me } = await admin.from("florists").select("email").eq("id", floristId).single();
    const key = contactKey(me?.email as string | null | undefined);
    if (key === null) return false; // no identity to collide on

    // Every other listing sharing this inbox.
    const { data: siblings } = await admin
      .from("florists")
      .select("id")
      .ilike("email", key)
      .neq("id", floristId)
      .limit(200);
    const siblingIds = (siblings ?? []).map((f) => f.id as string);
    if (siblingIds.length === 0) return false;

    const { data: live } = await admin
      .from("sequence_enrolments")
      .select("id")
      .in("florist_id", siblingIds)
      .in("status", ["active", "paused"])
      .limit(1);
    return (live ?? []).length > 0;
  } catch (e) {
    captureError("sequences.contactAlreadyEnrolled", e);
    return false;
  }
}

/**
 * Start a florist on a sequence. Idempotent: the partial unique index means a
 * second call while a run is live is a benign no-op rather than a duplicate
 * funnel, so a double-clicked "Send" in the outreach panel cannot double the
 * florist's mail.
 *
 * `firstTouchSent` is true when the caller has ALREADY sent step 0 (which is
 * how recruiting works — the outreach panel's send is what enrols them). The
 * enrolment then starts at step 1 with the counters already spent, so the tick
 * never re-sends the email the florist just received.
 */
export async function enrol(
  admin: Admin,
  opts: {
    floristId: string;
    sequenceId: SequenceId;
    orderId?: string | null;
    assignmentId?: string | null;
    firstTouchSent?: { email: boolean; sms: boolean };
  }
): Promise<{ ok: boolean; id?: string; reason?: string }> {
  const { floristId, sequenceId, orderId = null, assignmentId = null, firstTouchSent } = opts;
  // Staff-set waits (/flows) over the code defaults. This function PARKS the
  // row on the second step's due time, and the tick only ever looks at rows
  // that are already due — so a wait shortened here and not applied there
  // would not take effect until the original, longer wait had elapsed.
  const def = resolveSequence(sequenceDef(sequenceId), await loadStepConfig(admin), applyStepTiming);
  const nowIso = new Date().toISOString();

  // CONTACT-LEVEL DEDUPE. `florists` is one row per MAP LISTING, not per
  // business: a chain, or one shop listed under several place ids, is several
  // rows sharing one inbox. On live data 76 addresses are shared across
  // listings and one appears on 33 of them — enrolling each separately would
  // put four emails × 33 into a single inbox, from a funnel whose entire pitch
  // is that we are not a marketing list.
  //
  // The row-level unique index cannot catch this (33 distinct florist_ids are
  // 33 legitimately distinct rows), so the check is on the thing a message is
  // actually delivered to.
  const dupe = await contactAlreadyEnrolled(admin, floristId);
  if (dupe) return { ok: false, reason: "duplicate-contact" };

  const stepIndex = firstTouchSent ? 1 : 0;
  const touchesEmail = firstTouchSent?.email ? 1 : 0;
  const touchesSms = firstTouchSent?.sms ? 1 : 0;

  // Park it on the second step's due time so the tick isn't re-reading a row
  // that has nothing to do until then.
  const second = def.steps.filter((s) => s.track === "cold")[stepIndex];
  const nextActionAt = second
    ? new Date(Date.parse(nowIso) + stepOffsetMs(second)).toISOString()
    : nowIso;

  const { data, error } = await admin
    .from("sequence_enrolments")
    .insert({
      florist_id: floristId,
      sequence_id: sequenceId,
      order_id: orderId,
      assignment_id: assignmentId,
      status: "active",
      track: "cold",
      step_index: stepIndex,
      next_action_at: nextActionAt,
      last_touch_at: firstTouchSent ? nowIso : null,
      touches_email: touchesEmail,
      touches_sms: touchesSms,
    })
    .select("id")
    .single();

  if (error) {
    // 23505 = already enrolled (the partial unique index). Expected under a
    // retry or a double click, and not worth surfacing as a failure.
    if ((error as { code?: string }).code === "23505") return { ok: false, reason: "already-enrolled" };
    captureError("sequences.enrol", error);
    return { ok: false, reason: error.message };
  }

  return { ok: true, id: data?.id as string };
}

/** End a run. Terminal — the partial unique index frees the florist to be
 * enrolled again later, which is what long-term nurture will eventually do. */
export async function stop(
  admin: Admin,
  enrolmentId: string,
  reason: StopReason
): Promise<void> {
  const status = reason === "joined" ? "converted" : reason === "exhausted" ? "exhausted" : "stopped";
  const { error } = await admin
    .from("sequence_enrolments")
    .update({ status, stop_reason: reason, updated_at: new Date().toISOString() })
    .eq("id", enrolmentId)
    .in("status", ["active", "paused"]); // CAS: never resurrect a finished run
  if (error) captureError("sequences.stop", error);
}

/** Stop every live run for a florist. The one call an opt-out, a bounce or a
 * join needs to make — none of those are about a particular sequence. */
export async function stopAllForFlorist(
  admin: Admin,
  floristId: string,
  reason: StopReason
): Promise<number> {
  const status = reason === "joined" ? "converted" : "stopped";
  const { data, error } = await admin
    .from("sequence_enrolments")
    .update({ status, stop_reason: reason, updated_at: new Date().toISOString() })
    .eq("florist_id", floristId)
    .in("status", ["active", "paused"])
    .select("id");
  if (error) {
    captureError("sequences.stopAllForFlorist", error);
    return 0;
  }
  return (data ?? []).length;
}

/**
 * An order offer preempts recruiting: pause every live recruiting run for this
 * florist so they never get "join our network" in the window between an offer
 * and its expiry.
 *
 * Called from the offer send path. Best-effort by design — a pause that fails
 * must never block a real order going out.
 */
export async function pauseRecruitingFor(
  admin: Admin,
  floristId: string,
  preemptedBy: string | null
): Promise<number> {
  const { data, error } = await admin
    .from("sequence_enrolments")
    .update({ status: "paused", paused_by: preemptedBy, updated_at: new Date().toISOString() })
    .eq("florist_id", floristId)
    .eq("sequence_id", "recruit_cold")
    .eq("status", "active")
    .select("id");
  if (error) {
    captureError("sequences.pauseRecruiting", error);
    return 0;
  }
  return (data ?? []).length;
}

/**
 * The order went elsewhere — put recruiting back exactly where it was.
 *
 * `step_index` and `track` are untouched on purpose: a prospect who had already
 * seen two touches resumes at the third, rather than starting the pitch over.
 * The clock restarts from now (via `resumeDelayHours`) so the resumed touch
 * doesn't land the same hour as the offer's own follow-up.
 */
export async function resumeRecruitingFor(
  admin: Admin,
  floristId: string,
  resumeDelayHours = 24
): Promise<number> {
  const nextActionAt = new Date(Date.now() + resumeDelayHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from("sequence_enrolments")
    .update({ status: "active", paused_by: null, next_action_at: nextActionAt, updated_at: new Date().toISOString() })
    .eq("florist_id", floristId)
    .eq("sequence_id", "recruit_cold")
    .eq("status", "paused")
    .select("id");
  if (error) {
    captureError("sequences.resumeRecruiting", error);
    return 0;
  }
  return (data ?? []).length;
}
