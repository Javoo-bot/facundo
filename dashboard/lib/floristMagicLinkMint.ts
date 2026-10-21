import { randomUUID } from "node:crypto";
import type { createServiceClient } from "@/lib/supabaseAdmin";
import { FLORIST_BASE } from "@/lib/emailLinks";
import { buildMagicUrl, magicTokenExpiry, TEST_MODE_MAGIC_TOKEN, isSafeDest } from "@/lib/floristMagicLink";

// The one I/O seam for magic links: mint + insert. Split from
// lib/floristMagicLink.ts so that module stays pure and alias-free (plain
// `node --test` can't resolve "@/" aliases), the same split
// lib/offerEmailContent.ts / lib/offerVars.ts already use.

type Admin = ReturnType<typeof createServiceClient>;

export interface MintMagicLinkInput {
  floristId: string;
  /** Relative path the link lands on, e.g. "/florist/orders/<assignmentId>". */
  dest: string;
  /** Why this link was minted. `staff_link` is a link a staffer sent by hand
   *  (lib/floristMagicEmail.ts), as opposed to one riding inside an offer or an
   *  issue thread. Free text in the DB (`florist_magic_tokens.purpose` has no
   *  CHECK) — this union is the app-side contract. */
  purpose: "offer" | "issue" | "onboarding" | "staff_link" | "accept_confirm";
  assignmentId?: string | null;
  /** Test-mode / preview sends pass true to get the inert sentinel and skip
   * the write entirely. See TEST_MODE_MAGIC_TOKEN. */
  placeholder?: boolean;
  now?: Date;
}

/**
 * Mints a single-send sign-in link for a florist and returns its absolute URL.
 *
 * Reusable within a 30-day window rather than single-use: corporate link
 * scanners (Outlook Safe Links) and Gmail's prefetcher follow URLs before the
 * human ever clicks, and a single-use token would already be spent by then —
 * the florist would see "link expired" on a perfectly good email.
 *
 * Falls back to the inert sentinel (never a bare order URL) if the insert
 * fails: a link that bounces the florist to login is a bad day, a link that
 * silently 404s the PWA shell is worse, and neither is a reason to fail the
 * whole send.
 */
export async function mintMagicLink(admin: Admin, input: MintMagicLinkInput): Promise<string> {
  if (!isSafeDest(input.dest)) throw new Error(`mintMagicLink: unsafe dest ${JSON.stringify(input.dest)}`);
  if (input.placeholder) return buildMagicUrl(FLORIST_BASE, TEST_MODE_MAGIC_TOKEN);

  const now = input.now ?? new Date();
  const token = randomUUID();
  const { error } = await admin.from("florist_magic_tokens").insert({
    token,
    florist_id: input.floristId,
    dest: input.dest,
    purpose: input.purpose,
    assignment_id: input.assignmentId ?? null,
    expires_at: magicTokenExpiry(now),
  });
  if (error) {
    console.error("mintMagicLink: insert failed", error.message);
    return buildMagicUrl(FLORIST_BASE, TEST_MODE_MAGIC_TOKEN);
  }
  return buildMagicUrl(FLORIST_BASE, token);
}
