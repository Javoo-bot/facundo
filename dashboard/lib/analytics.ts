// Thin PostHog seam, in the spirit of lib/monitor.ts: the rest of the app calls
// these two functions and never imports posthog-js directly, so swapping or
// removing the vendor is a one-file change.
//
// Every function no-ops when PostHog wasn't initialized (no NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
// — see instrumentation-client.ts), which is the normal case in local dev.
// Browser-only: posthog-js is a client singleton, so these must not be called
// from server components.
//
// This module also owns BOTH exclusion rules (see identifyUser):
//   1. Replay is off on localhost/staging — dev and staging noise isn't worth
//      recording, but their events still flow so a deploy stays verifiable.
//   2. Listed internal emails are opted out of PostHog entirely.
import posthog from "posthog-js";
import { parseExcludedEmails, isExcludedEmail, replayAllowedOnHost } from "./analyticsRules";

/** Which of the two authenticated surfaces the session is on. Registered as a
 * super property so every event is attributable without inferring from URLs. */
export type Surface = "staff" | "florist";

export type Identity = {
  /** Supabase auth user id. Deliberately the distinct_id on BOTH surfaces, so a
   * person is one person in PostHog even if they appear on each. */
  distinctId: string;
  email: string;
  surface: Surface;
  /** Florist surface only — the florists.id this user maps to. */
  floristId?: string;
};

/** Internal emails that should never reach PostHog at all — no replay, no
 * events — so the team's own clicks don't skew funnels or fill the replay list.
 * Comma-separated, build-time (inlined by `next build`), so changing it needs a
 * rebuild — fine for a small, stable list. Unset = exclude nobody. */
// Module-level read, per the NEXT_PUBLIC_* convention — inlined by `next build`.
const EXCLUDED_EMAILS = parseExcludedEmails(process.env.NEXT_PUBLIC_POSTHOG_EXCLUDED_EMAILS);

/** Associates the current session with a signed-in user, and applies the two
 * exclusion rules. Safe to call on every mount: identify() is idempotent for the
 * same distinct_id, and re-calling is what heals an id reset by iOS ITP storage
 * eviction or a PWA's separate storage jar.
 *
 * Replay starts here rather than at init (instrumentation-client.ts sets
 * `disable_session_recording: true`) because the user's identity isn't known
 * until hydration. Starting recording at init and stopping it here would always
 * capture the first seconds of an excluded user's session before we knew to
 * stop. The cost of this ordering: pre-auth pages (both login screens) are never
 * recorded, since nothing calls this until a user is resolved. */
export function identifyUser({ distinctId, email, surface, floristId }: Identity): void {
  if (!posthog.__loaded) return;

  if (isExcludedEmail(email, EXCLUDED_EMAILS)) {
    // opt_out_capturing() persists to storage, so on every later page load
    // posthog no-ops straight from init — this browser stops sending anything.
    if (!posthog.has_opted_out_capturing()) posthog.opt_out_capturing();
    return;
  }

  // Opt-out is sticky, so someone removed from EXCLUDED_EMAILS would otherwise
  // stay silent forever on a browser that once opted them out. captureEventName:
  // false keeps this from emitting a synthetic $opt_in event on every login.
  if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing({ captureEventName: false });

  posthog.identify(distinctId, { email, ...(floristId ? { florist_id: floristId } : {}) });
  posthog.register({ surface });

  if (replayAllowedOnHost(window.location.hostname) && !posthog.sessionRecordingStarted()) {
    posthog.startSessionRecording();
  }
}

/** Clears the identity so a subsequent sign-in on the same browser isn't
 * stitched onto the previous person. Call on sign-out only.
 *
 * Re-applies the opt-out because posthog.reset() calls consent.reset()
 * internally, which DELETES the persisted `__ph_opt_in_out_<token>` marker.
 * Without this, an excluded user would be silently un-excluded by their own
 * sign-out: the next load has no marker, and posthog's init fires its initial
 * $pageview on a 1ms timer — long before hydration can call identifyUser() to
 * opt them back out. That made the exclusion leak a pageview on every
 * sign-out/sign-in cycle rather than at most once per browser.
 *
 * Safe for a different person on the same browser: a non-excluded user's
 * identifyUser() opts them back in on their next sign-in. The cost is that
 * their first pageview after an excluded user signed out here is dropped. */
export function resetUser(): void {
  if (!posthog.__loaded) return;
  const wasOptedOut = posthog.has_opted_out_capturing();
  posthog.reset();
  if (wasOptedOut) posthog.opt_out_capturing();
}

/**
 * Fire-and-forget custom event, through this module rather than posthog-js so
 * the vendor seam at the top of this file holds.
 *
 * PRE-AUTH CALLERS ARE THE POINT: the sign-in screen fires this before anyone
 * is identified, which means the two exclusion rules cannot apply — we don't
 * know whose browser this is yet. That is already true of the initial
 * $pageview (posthog's init fires it on a 1ms timer, long before hydration
 * could identify anyone), so this adds no new category of exposure, only one
 * more event on a page that already reports itself. A browser that was opted
 * out earlier stays silent: the opt-out marker is persisted, and capture()
 * no-ops against it.
 *
 * Deliberately NOT a replacement for the server-side login_failures row
 * (lib/loginFailures.ts). This is a client-side signal and cannot see WHY the
 * exchange failed — that error exists only inside the callback's 307. The two
 * answer different questions: this one "how often, on what browser, and what
 * did that person do next", the table "what exactly broke".
 */
export function captureEvent(event: string, properties?: Record<string, unknown>): void {
  if (!posthog.__loaded) return;
  posthog.capture(event, properties);
}
