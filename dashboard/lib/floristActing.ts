import "server-only";
import { cookies } from "next/headers";
import {
  encodeActingClaim,
  decodeActingClaim,
  type FloristActingClaim,
} from "./floristActingToken";

/**
 * "Which shop is this session working as", carried on a signed cookie set by
 * the magic-link route from the token it just redeemed.
 *
 * See lib/floristActingToken.ts for why this exists — in short, a florist is
 * signed in by email, a shop is not an address, and `florist_users` can only
 * map one auth user to one shop. Cookie I/O and the live-session check live
 * here; the signing is pure and tested separately.
 */

export const FLORIST_ACTING_COOKIE = "fc_florist";

/** Matched to the magic token's own 30-day life (supabase migration
 *  2026-08-04-florist-magic-links). A florist who keeps the app open, or comes
 *  back to a bookmarked page days later, should still be the shop their link
 *  named — and every fresh link re-stamps it. Shorter would silently fall back
 *  to `florist_users`, which for a shared inbox is the WRONG shop: worse than
 *  being signed out, because it looks like it worked. */
export const FLORIST_ACTING_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function secret(): string {
  // Same server-only secret the view-as claim uses; never shipped to a client.
  const s = process.env.VIEW_AS_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!s) throw new Error("florist acting-as signing secret not configured");
  return s;
}

export function newActingClaim(floristId: string, userId: string): FloristActingClaim {
  return { floristId, userId, exp: Date.now() + FLORIST_ACTING_TTL_MS };
}

/** Write the cookie. Called by the magic-link route once the token has proved
 *  which shop this is. */
export async function setActingFlorist(floristId: string, userId: string, host: string | null): Promise<void> {
  const jar = await cookies();
  const { sharedCookieDomain } = await import("./hostRouting");
  jar.set(FLORIST_ACTING_COOKIE, encodeActingClaim(newActingClaim(floristId, userId), secret()), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(FLORIST_ACTING_TTL_MS / 1000),
    domain: sharedCookieDomain(host),
  });
}

/**
 * The shop this session is working as, or null.
 *
 * Refuses a claim that is unsigned, tampered with, expired, or minted for a
 * DIFFERENT auth user — so the cookie alone grants nothing if it is lifted into
 * another browser, and a signed-in florist cannot point it at a shop that is
 * not theirs.
 */
export async function resolveActingFlorist(userId: string): Promise<string | null> {
  const jar = await cookies();
  const raw = jar.get(FLORIST_ACTING_COOKIE)?.value;
  if (!raw) return null;
  const claim = decodeActingClaim(raw, secret());
  if (!claim) return null;
  if (claim.exp < Date.now()) return null;
  if (claim.userId !== userId) return null;
  return claim.floristId;
}
