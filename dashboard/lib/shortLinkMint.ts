import type { createServiceClient } from "@/lib/supabaseAdmin";
import { BACKOFFICE_BASE } from "@/lib/emailLinks";
import { generateShortCode, buildShortUrl } from "@/lib/shortLink";

// The one I/O seam for shortening. The generator itself stays pure in
// lib/shortLink.ts, mirroring the floristMagicLink / floristMagicLinkMint split.

type Admin = ReturnType<typeof createServiceClient>;

export interface ShortenMeta {
  kind: "magic" | "unsubscribe";
  floristId?: string | null;
  assignmentId?: string | null;
}

/**
 * Mint a short link for `targetUrl` and return its absolute URL.
 *
 * FALLS BACK TO THE FULL URL on any failure, and never throws. Shortening is an
 * optimisation: a long link costs an SMS segment, a missing link costs the
 * order. It must not be able to fail a send.
 *
 * Always mints a fresh code rather than reusing one for the same target — two
 * sends to the same florist stay independently revocable and independently
 * countable, and nothing in the message reveals that two links are the same.
 */
export async function shorten(admin: Admin, targetUrl: string, meta: ShortenMeta): Promise<string> {
  try {
    // Bounded retry: a collision at 62^10 is vanishingly unlikely, but a unique
    // violation should be a retry rather than a 500.
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateShortCode();
      const { error } = await admin.from("short_links").insert({
        code,
        target_url: targetUrl,
        kind: meta.kind,
        florist_id: meta.floristId ?? null,
        assignment_id: meta.assignmentId ?? null,
      });
      if (!error) return buildShortUrl(BACKOFFICE_BASE, code);
      if (error.code !== "23505") break; // not a collision — stop retrying
    }
  } catch {
    // fall through to the un-shortened URL
  }
  return targetUrl;
}
