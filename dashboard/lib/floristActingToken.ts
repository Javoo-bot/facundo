import { createHmac, timingSafeEqual } from "node:crypto";

// Pure signing/verification for the "which shop is this session working as"
// cookie. Free of `server-only`, next/headers and DB deps so it can be
// unit-tested directly (lib/floristActingToken.test.mjs), exactly like
// lib/viewAsToken.ts, whose shape this follows.
//
// WHY THE COOKIE EXISTS AT ALL.
//
// A florist is signed in BY EMAIL: app/florist/m/[token] calls generateLink on
// `florists.email`, so the auth user is derived from the address. But a shop is
// not an address, and two things follow that both lock a florist out:
//
//   SHARED INBOX. 695 of 2,274 emailable shops share an address with another
//   shop — 686 of them behind real chains, one head office covering 115 shops.
//   `florist_users` has user_id as its PRIMARY KEY, so one auth user maps to
//   exactly one shop. The second shop's link signs in as the FIRST, and the
//   accept comes back 403 "Not your offer."
//
//   CHANGED ADDRESS. Where `florists.email` no longer matches the address the
//   owner signed up with, the link mints a different auth user, and inserting
//   its mapping is refused by florist_users_one_owner_idx (one owner per shop).
//   The florist lands in the app signed in as nobody and every API answers 401.
//
// The magic-link route has always known which shop the link was for — it is on
// the token row, and that route's own comment says "the token is the authority
// on which florist this is". It was not: `florist_users` was. This claim makes
// the comment true by carrying the answer on the session.
//
// BOUND TO THE USER, DELIBERATELY. The claim names the auth user it was minted
// for, and the reader refuses it for any other session. So the cookie is
// useless on its own — lifting it into another browser grants nothing — and a
// signed-in florist cannot edit it to name a shop that is not theirs, because
// it is HMAC-signed with a server-only secret. Both halves are required: the
// signature stops forgery, the user binding stops replay.

export type FloristActingClaim = {
  /** The shop this session is working as. */
  floristId: string;
  /** The auth user the claim was minted for. Any other session must ignore it. */
  userId: string;
  exp: number;
};

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/** Encode + HMAC-sign a claim into a `body.sig` token. */
export function encodeActingClaim(claim: FloristActingClaim, secret: string): string {
  const body = Buffer.from(JSON.stringify(claim)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

/**
 * Verify signature + shape and return the claim, or null when the token is
 * malformed or tampered with.
 *
 * Expiry is NOT checked here — the caller compares `claim.exp` against the
 * current time, keeping this module time-pure and therefore testable without
 * freezing a clock. Nor is the user binding checked here; that needs the live
 * session, which belongs in lib/floristActing.ts.
 */
export function decodeActingClaim(token: string, secret: string): FloristActingClaim | null {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // Constant-time compare; timingSafeEqual throws on a length mismatch, so guard.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claim = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as FloristActingClaim;
    if (
      !claim ||
      typeof claim.floristId !== "string" ||
      typeof claim.userId !== "string" ||
      typeof claim.exp !== "number"
    ) {
      return null;
    }
    return claim;
  } catch {
    return null;
  }
}
