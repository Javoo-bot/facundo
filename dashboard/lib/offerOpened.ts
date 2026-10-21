import "server-only";

import type { createServiceClient } from "@/lib/supabaseAdmin";

// "This florist actually looked at the offer."
//
// WHY THIS EXISTS. `order_assignments.status = 'opened'` and `opened_at` have
// been in the schema, and in every `.in([...])` filter in the codebase, since
// the first version of the order loop — and nothing has ever written them. A
// florist who read the offer twice and ignored it was indistinguishable from
// one who never received the email. A France end-to-end run on 2026-09-03
// measured it: a real florist session loaded the real offer page, got HTTP 200,
// and the row stayed `sent` with `opened_at` NULL.
//
// WHY NOT THE EMAIL PROVIDER'S OPEN PIXEL. Two reasons.
//
//  1. It does not exist in every environment. Transport is chosen per
//     environment (lib/emailTransport.ts): production runs Resend, which has a
//     delivery/open/click webhook; STAGING runs Ongage, which has no equivalent
//     yet. Hanging this on the pixel would mean the signal is missing exactly
//     where we do our QA.
//  2. An open pixel is weak evidence anywhere. Apple Mail Privacy Protection
//     and corporate scanners fetch images the recipient never saw, so a pixel
//     open is a claim about a mail client, not about a person.
//
// Redeeming the offer link is a STRONGER signal than either, and it is one we
// own on both transports: somebody tapped the button in that email and we
// signed them in. That is the thing the desk actually wants to know.
//
// The email-provider signals are still collected and still shown per candidate
// on the order page by lib/candidateEngagement.ts (sent › delivered › opened ›
// clicked › signed_in). This is deliberately the coarser, more reliable half of
// that funnel, promoted onto the assignment itself so the CX queue and the
// wave engine can read it without four extra joins.

type Admin = ReturnType<typeof createServiceClient>;

/**
 * Record that the florist opened this offer.
 *
 * CAS'd from `sent` alone, which gives three things at once:
 *  - a candidate that was never sent cannot be marked opened;
 *  - a second visit is a no-op, so `opened_at` keeps the FIRST open;
 *  - an assignment that has since been accepted, declined, expired or withdrawn
 *    is left alone — those are later, more meaningful states and must not be
 *    rewound by someone re-opening the email.
 *
 * Every consumer already handles `opened`: it sits alongside `sent` in
 * lib/reachout.ts's LIVE, in OPEN_STATUSES, in RESENDABLE_STATUSES, in
 * ACCEPTABLE_ASSIGNMENT_STATUSES and in the wave engine's live-offer and expiry
 * queries. So this flips a status the system was always written to expect and
 * had simply never seen.
 *
 * Never throws — it is called from the sign-in redirect path, and failing to
 * record an open must not stop a florist reaching their order.
 */
export async function markOfferOpened(admin: Admin, assignmentId: string | null | undefined): Promise<boolean> {
  if (!assignmentId) return false;
  try {
    const { data } = await admin
      .from("order_assignments")
      .update({ status: "opened", opened_at: new Date().toISOString() })
      .eq("id", assignmentId)
      .eq("status", "sent")
      .select("id, order_id");
    if (!data?.length) return false;
    // An event too, so "when did they look?" survives a later status change and
    // shows up on the order timeline next to outreach_sent and offer_expired.
    await admin.from("order_events").insert({
      order_id: data[0].order_id,
      type: "offer_opened",
      payload: { assignmentId },
      actor: "florist",
    });
    return true;
  } catch {
    return false;
  }
}
