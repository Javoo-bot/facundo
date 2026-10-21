/** Magic-link decision + URL logic for florist-facing messages.
 *
 * One click from an offer email / offer SMS / issue notification signs the
 * florist in and lands them on the order the message was about. Before this,
 * every one of those links pointed at `/florist/orders/<id>`, hit the auth
 * redirect in app/florist/(app)/layout.tsx, LOST the path, and dumped the
 * florist on the home screen after a six-digit OTP.
 *
 * Pure + alias-free (relative imports only) so plain `node --test` can reach
 * it — same convention as lib/floristJoin.ts and lib/offerEmailContent.ts.
 * The mint (randomUUID + the insert) lives in lib/floristMagicLinkMint.ts,
 * the one I/O seam; `now` is always passed in so nothing here reads the clock.
 */

/** Matches JOIN_TOKEN_TTL_DAYS (lib/floristJoin.ts) — an emailed link goes
 * stale on its own rather than living in an inbox forever. */
export const MAGIC_TOKEN_TTL_DAYS = 30;

/** Inert token used for test-mode sends and for the zero-write staff preview.
 *
 * Same guard lib/offerVars.ts applies to `unsubscribe_token` (see its
 * test-mode comment): a test send is redirected to the SHARED staff test
 * inbox, so it must never carry a real florist's token. For unsubscribe that
 * would let a staffer irreversibly opt a real shop out; for a magic token it
 * would hand them a live LOGIN to that shop. `magicTokenBlockReason` rejects
 * this value before any lookup, so it cannot be made valid by a stray DB row
 * either. */
export const TEST_MODE_MAGIC_TOKEN = "test-mode-magic-token";

export interface MagicTokenState {
  dest: string;
  expires_at: string;
  revoked_at: string | null;
}

export type MagicTokenBlockReason = "not-found" | "revoked" | "expired" | "sentinel" | "bad-dest";

export function magicTokenExpiry(now: Date): string {
  return new Date(now.getTime() + MAGIC_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export function buildMagicUrl(origin: string, token: string): string {
  return `${origin}/florist/m/${token}`;
}

/** True for a path we are willing to redirect to after a sign-in: relative,
 * single leading slash. Rejects `//evil.com` (protocol-relative — a browser
 * treats it as an absolute URL), any scheme, and the empty string.
 *
 * Same rule app/auth/callback/route.ts already applies to its `next` param,
 * lifted here so the redeem route, the login page, and the layout all share
 * ONE definition instead of three copies that can drift apart. */
export function isSafeDest(dest: string | null | undefined): boolean {
  if (!dest) return false;
  return dest.startsWith("/") && !dest.startsWith("//");
}

/** The single authority on whether a magic token may be redeemed. Returns
 * null when it may, or why not.
 *
 * The sentinel is checked FIRST, before `row` is even consulted, so a
 * test-mode link can never be redeemed no matter what is in the table. */
export function magicTokenBlockReason(
  token: string,
  row: MagicTokenState | null,
  now: Date
): MagicTokenBlockReason | null {
  if (token === TEST_MODE_MAGIC_TOKEN) return "sentinel";
  if (!row) return "not-found";
  if (row.revoked_at) return "revoked";
  if (new Date(row.expires_at).getTime() <= now.getTime()) return "expired";
  // Defence in depth: `dest` is written by our own mint calls, but a redirect
  // is exactly the thing that must not trust its input, so re-validate rather
  // than assume the write was well-formed.
  if (!isSafeDest(row.dest)) return "bad-dest";
  return null;
}

/** Where to send someone whose token didn't work: the normal login page, with
 * the destination preserved so they still land on the right order after
 * signing in the ordinary way. A dead link becomes a detour, not a dead end. */
export function loginFallbackPath(dest: string | null, reason: MagicTokenBlockReason): string {
  const safe = isSafeDest(dest) ? dest! : "/florist";
  return `/florist/login?next=${encodeURIComponent(safe)}&reason=${encodeURIComponent(reason)}`;
}

/** The order page a given assignment's messages should deep-link to. One
 * definition, so the email CTA, the SMS body and the issue email can't drift. */
export function orderDest(assignmentId: string): string {
  return `/florist/orders/${assignmentId}`;
}
