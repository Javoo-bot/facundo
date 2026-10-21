// The recruiting funnel's product events, for PostHog.
//
// ---- Why these exist
//
// PostHog was write-only and ERROR-only: the four events the code emitted were
// all failure signals, so the funnel this project is about was invisible there.
// The browser side already sees the BOTTOM of it — /florist/accept/<token>
// generates real pageviews — but the send, the open and the click all happen
// server-side or in a webhook and reached nothing.
//
// ---- The identity join, which is the whole trick
//
// A prospect florist is not a logged-in user. Server-side we know them by
// `florists.id`; in the browser they are an anonymous visitor with a PostHog
// device id, and they do not become "someone" until they finish the join form.
// Emit the server events under one id and let the browser keep another, and
// PostHog holds TWO funnels that never meet — sent → opened → clicked, and
// landed → joined — with no way to ask the only interesting question, which is
// what fraction of the people we mailed actually arrive.
//
// So both halves key on the SAME string, `distinctIdFor(floristId)`, and the
// join page calls posthog.identify() with it the moment it loads. From then on
// the anonymous pageviews that led up to it are aliased onto the florist, and
// the funnel is one funnel.
//
// Never throws and no-ops without POSTHOG_PROJECT_TOKEN — captureServerEvent's
// contract. A missing analytics key must never cost a send.

import { captureServerEvent } from "@/lib/serverAnalytics";

/** The subject a recruiting event belongs to.
 *
 * Prefixed rather than a bare uuid so a florist and a staff user can never
 * collide in PostHog's person table: staff identify by their Supabase auth id
 * (components/PostHogIdentify.tsx), and both are uuids. */
export function distinctIdFor(floristId: string): string {
  return `florist:${floristId}`;
}

export const RECRUIT_EMAIL_SENT = "recruit_email_sent";
export const RECRUIT_EMAIL_OPENED = "recruit_email_opened";
export const RECRUIT_EMAIL_CLICKED = "recruit_email_clicked";
export const RECRUIT_JOINED = "recruit_joined";

export interface TouchProps {
  /** The funnel step: `t1`, `t2`, `t3`, `r1`, `r2`, `co1`… Lets PostHog answer
   * "which angle earns the click", which is the per-step question
   * get_funnel_stats answers in SQL. */
  step?: string | null;
  sequence?: string | null;
  city?: string | null;
  country?: string | null;
  locale?: string | null;
  /** Which gate let this touch through — `not-opened`, `opened`, or absent.
   * Without it the open-branching is invisible in PostHog and there is no way
   * to see that (say) every shop is being classified `unknown`. */
  gate?: string | null;
  /** True for a send that was redirected to the test inbox. Never mix test
   * traffic into a conversion rate without being able to filter it out. */
  testMode?: boolean | null;
}

function clean(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(props).filter(([, v]) => v !== null && v !== undefined));
}

export async function trackRecruitEmailSent(floristId: string, props: TouchProps): Promise<void> {
  await captureServerEvent(RECRUIT_EMAIL_SENT, distinctIdFor(floristId), clean({ ...props, florist_id: floristId }));
}

export async function trackRecruitEmailOpened(
  floristId: string,
  props: TouchProps & { genuine?: boolean }
): Promise<void> {
  // `genuine` carries whether openQuality accepted it. Both are emitted: the
  // gap between them IS the Apple/Gmail prefetch, and on prod that gap was
  // 1,560 opens against 1,068 deliveries. Dropping the rejected ones would hide
  // the single most useful thing this event can say about an open rate.
  await captureServerEvent(RECRUIT_EMAIL_OPENED, distinctIdFor(floristId), clean({ ...props, florist_id: floristId }));
}

export async function trackRecruitEmailClicked(
  floristId: string,
  props: TouchProps & { machine?: boolean }
): Promise<void> {
  await captureServerEvent(RECRUIT_EMAIL_CLICKED, distinctIdFor(floristId), clean({ ...props, florist_id: floristId }));
}

export async function trackRecruitJoined(floristId: string, props: TouchProps): Promise<void> {
  await captureServerEvent(RECRUIT_JOINED, distinctIdFor(floristId), clean({ ...props, florist_id: floristId }));
}
