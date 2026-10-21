import { createServiceClient } from "@/lib/supabaseAdmin";

// "Did this florist actually SEE the offer?" — resolved per assignment for the
// candidate list on the order page.
//
// Until this existed, the only thing the page could show was the assignment's
// own status: `sent` meant "we handed it to a provider", and a candidate who
// never received the email looked identical to one who read it twice and
// ignored it. Those are opposite problems: the first is ours to fix, the
// second is a florist who isn't interested.
//
// WHY SERVICE-ROLE. Two of the four sources are service-role-only tables, and
// deliberately so: `short_links` codes and `florist_magic_tokens` ARE
// credentials (each fronts a one-click login to a real shop), which is why
// neither has a staff read policy. Rather than open those tables up, this
// module reads them with the service key on the server and returns only
// DERIVED facts — booleans and timestamps. No token or short code ever crosses
// to the client. That is the narrow, auth-gated service-role read the project
// conventions allow, and the alternative (an RLS policy over a credential
// table) would be strictly worse.
//
// Every source is already keyed by `assignment_id`, so this is four indexed
// reads for the whole page, not per candidate.

/** The stages, in the order they must be reached. Exported so the component
 *  and any future consumer share one definition of the funnel. */
export const ENGAGEMENT_STAGES = ["sent", "delivered", "opened", "clicked", "signed_in"] as const;
export type EngagementStage = (typeof ENGAGEMENT_STAGES)[number];

export interface CandidateEngagement {
  /** When each stage was first reached; null means "not reached". */
  at: Record<EngagementStage, string | null>;
  /** Which channel produced the furthest evidence, for the tooltip. A florist
   *  can be emailed and texted for the same offer, and knowing WHICH one they
   *  responded to is the difference between fixing an address and fixing a
   *  number. */
  via: Partial<Record<EngagementStage, "email" | "sms" | "web">>;
}

export type EngagementByAssignment = Map<string, CandidateEngagement>;

const EMPTY: CandidateEngagement = {
  at: { sent: null, delivered: null, opened: null, clicked: null, signed_in: null },
  via: {},
};

/** Earliest of two possibly-null ISO timestamps. */
function earlier(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

/**
 * Resolve the engagement trail for a set of assignments.
 *
 * Returns a map keyed by assignment id; an assignment with no evidence at all
 * is present with every stage null rather than absent, so callers never have to
 * distinguish "no data" from "not looked up".
 *
 * MONOTONIC BY CONSTRUCTION: a later stage implies every earlier one. A click
 * cannot happen without a delivery, but the DELIVERY webhook can be missing
 * (dropped, or predating the webhook being configured — as every event before
 * 2026-08-06 was). Showing "clicked but never delivered" would send someone
 * chasing a delivery bug that isn't there, so earlier stages are backfilled
 * from the earliest later evidence. The tooltip still shows the real
 * timestamps, so nothing is invented — only ordered.
 */
export async function resolveCandidateEngagement(
  assignments: { id: string; florist_id: string; sent_at: string | null }[],
): Promise<EngagementByAssignment> {
  const out: EngagementByAssignment = new Map();
  if (assignments.length === 0) return out;

  const ids = assignments.map((a) => a.id);
  const admin = createServiceClient();

  const [{ data: comms }, { data: links }, { data: tokens }] = await Promise.all([
    admin
      .from("communications")
      .select("id, assignment_id, channel, status")
      .in("assignment_id", ids)
      .eq("audience", "florist"),
    admin
      .from("short_links")
      .select("assignment_id, kind, hit_count, first_hit_at")
      .in("assignment_id", ids),
    admin
      .from("florist_magic_tokens")
      .select("assignment_id, last_used_at")
      .in("assignment_id", ids),
  ]);

  // Delivery/open/click evidence hangs off the communication, not the
  // assignment, so map comm -> assignment first.
  const commIds = (comms ?? []).map((c) => c.id);
  const commToAssignment = new Map<string, string>();
  const commChannel = new Map<string, string>();
  for (const c of comms ?? []) {
    if (c.assignment_id) commToAssignment.set(c.id, c.assignment_id);
    commChannel.set(c.id, c.channel);
  }

  const [{ data: emailEvents }, { data: smsEvents }] = commIds.length
    ? await Promise.all([
        admin.from("email_events").select("communication_id, event_type, occurred_at").in("communication_id", commIds),
        admin.from("sms_events").select("communication_id, event_type, occurred_at").in("communication_id", commIds),
      ])
    : [{ data: [] }, { data: [] }];

  for (const a of assignments) {
    out.set(a.id, {
      at: { ...EMPTY.at, sent: a.sent_at ?? null },
      via: {},
    });
  }

  const touch = (
    assignmentId: string | null | undefined,
    stage: EngagementStage,
    when: string | null,
    via: "email" | "sms" | "web",
  ) => {
    if (!assignmentId) return;
    const row = out.get(assignmentId);
    if (!row) return;
    const before = row.at[stage];
    row.at[stage] = earlier(before, when);
    // First evidence for a stage names the channel; a second channel reaching
    // the same stage later doesn't overwrite it.
    if (!before) row.via[stage] = via;
  };

  for (const e of emailEvents ?? []) {
    const assignmentId = e.communication_id ? commToAssignment.get(e.communication_id) : null;
    if (e.event_type === "delivered") touch(assignmentId, "delivered", e.occurred_at, "email");
    else if (e.event_type === "opened") touch(assignmentId, "opened", e.occurred_at, "email");
    else if (e.event_type === "clicked") touch(assignmentId, "clicked", e.occurred_at, "email");
  }

  for (const e of smsEvents ?? []) {
    const assignmentId = e.communication_id ? commToAssignment.get(e.communication_id) : null;
    // An SMS has no 'opened' — see the Messaging section's note. Delivery is
    // the only carrier signal; the click comes from the short link below.
    if (e.event_type === "delivered") touch(assignmentId, "delivered", e.occurred_at, "sms");
  }

  for (const l of links ?? []) {
    // The unsubscribe link is not engagement with the offer — following it is
    // the opposite. Only the magic link counts.
    if (l.kind !== "magic") continue;
    if ((l.hit_count ?? 0) > 0) touch(l.assignment_id, "clicked", l.first_hit_at ?? null, "sms");
  }

  for (const t of tokens ?? []) {
    // The magic token was redeemed: the florist is signed in and standing on
    // this order. The strongest signal we have short of a decision.
    if (t.last_used_at) touch(t.assignment_id, "signed_in", t.last_used_at, "web");
  }

  // Backfill earlier stages from later evidence (see the doc comment).
  for (const row of out.values()) {
    for (let i = ENGAGEMENT_STAGES.length - 1; i > 0; i--) {
      const later = row.at[ENGAGEMENT_STAGES[i]];
      if (!later) continue;
      const prev = ENGAGEMENT_STAGES[i - 1];
      row.at[prev] = earlier(row.at[prev], later);
    }
  }

  return out;
}

/** The furthest stage reached, or null when nothing has been sent yet. Shared
 *  by the component and anything that wants a one-word summary. */
export function furthestStage(e: CandidateEngagement): EngagementStage | null {
  let furthest: EngagementStage | null = null;
  for (const stage of ENGAGEMENT_STAGES) {
    if (e.at[stage]) furthest = stage;
  }
  return furthest;
}
