/** Join-link lifecycle for the recruiting-email CTA
 * (app/api/florists/draft-email, app/florist/accept/[token]). Pure
 * decision/URL logic only — the actual token mint (`randomUUID()`) and DB
 * read/write happen in the route, the one I/O seam. `now` is always passed in
 * so this stays pure and testable (no Date.now() inside the module). */

const JOIN_TOKEN_TTL_DAYS = 30;

export interface JoinTokenState {
  join_token: string | null;
  join_token_expires_at: string | null;
  joined_at: string | null;
}

/** True when the florist needs a freshly minted token: none set yet, or the
 * existing one has expired. Never true for a florist who already joined —
 * regenerating a draft for someone already in the network must not mint (or
 * imply sending) a new link. */
export function needsNewJoinToken(florist: JoinTokenState, now: Date): boolean {
  if (florist.joined_at) return false;
  if (!florist.join_token || !florist.join_token_expires_at) return true;
  return new Date(florist.join_token_expires_at).getTime() <= now.getTime();
}

export function joinTokenExpiry(now: Date): string {
  return new Date(now.getTime() + JOIN_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export function buildJoinUrl(origin: string, token: string): string {
  return `${origin}/florist/accept/${token}`;
}
