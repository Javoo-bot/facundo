// Pure channel-routing logic for the florist unsubscribe flow, split out of
// app/api/florist/unsubscribe/route.ts (the one I/O caller) so it's
// unit-testable directly via plain `node --test` without a real DB — same
// "no I/O here, test it directly" split as lib/reachoutSend.ts's
// offerEmailContent.ts sibling (see lib/unsubscribeChannel.test.mjs).

export type UnsubscribeChannel = "email" | "sms";
export type UnsubscribeAction = "snooze" | "stop";

/** The sentinel token used in place of a real florist's unsubscribe token in
 * every TEST-MODE send (see lib/offerVars.ts). It deliberately matches no row
 * in `florists.unsubscribe_token`, so a staffer reviewing a test message can
 * never opt a real florist out by tapping the link.
 *
 * It is a shared constant rather than a repeated string literal because THREE
 * places must agree on it: the sender that mints it, the page that renders a
 * preview for it, and the API route that must refuse to act on it. */
export const TEST_MODE_UNSUBSCRIBE_TOKEN = "test-mode-preview";

/** True when this token is the test-mode sentinel rather than a real florist
 * token. The page uses it to render a clearly-labelled PREVIEW of the opt-out
 * screen (so the flow is actually verifiable before go-live) instead of a bare
 * "link not found", and the API route uses it to reject the token outright. */
export function isTestModeUnsubscribeToken(token: string): boolean {
  return token === TEST_MODE_UNSUBSCRIBE_TOKEN;
}

/** Validates a raw `channel` value from the unsubscribe API's request body.
 * `undefined` (the field entirely absent) defaults to `"email"` so every
 * unsubscribe link minted before SMS existed — none of which carry a
 * `channel` param — keeps behaving byte-for-byte as before. Anything other
 * than `undefined`, `"email"`, or `"sms"` (including `null`, numbers, or a
 * typo'd string) is invalid: returns `null` so the route can 400 rather than
 * silently coercing it to either channel. */
export function resolveUnsubscribeChannel(raw: unknown): UnsubscribeChannel | null {
  if (raw === undefined) return "email";
  if (raw === "email" || raw === "sms") return raw;
  return null;
}

export type UnsubscribeUpdate =
  | { order_sms_snoozed_until: string }
  | { order_sms_opt_out: true }
  | { order_emails_snoozed_until: string }
  | { order_emails_opt_out: true };

/** Builds the exact column-update object for a validated channel+action
 * pair. The two channels' opt-out columns are fully independent by
 * construction — this can never set both in one call, so opting out of SMS
 * never touches the email columns and vice versa. */
export function buildUnsubscribeUpdate(
  channel: UnsubscribeChannel,
  action: UnsubscribeAction,
  snoozeUntilIso: string
): UnsubscribeUpdate {
  return channel === "sms"
    ? action === "snooze"
      ? { order_sms_snoozed_until: snoozeUntilIso }
      : { order_sms_opt_out: true }
    : action === "snooze"
      ? { order_emails_snoozed_until: snoozeUntilIso }
      : { order_emails_opt_out: true };
}
